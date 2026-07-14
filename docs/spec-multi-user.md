# Spec: Gastaker multi-usuario

## Resumen

Hoy Gastaker es estrictamente single-user: la auth es una password global (`APP_PASSWORD`)
con un token de sesión estático (`SESSION_TOKEN`), la ingesta valida un secreto global
(`WEBHOOK_SECRET`) y el agente de WhatsApp está restringido a un número del env
(`NOTIFY_WHATSAPP`). Toda la data vive en tres tablas sin dueño (`expenses`,
`comercios_conocidos`, `categories`).

Esta spec lo convierte en multi-usuario:

- **Tabla `users`** con email + password (scrypt de `node:crypto`, cero deps nuevas),
  un `ingest_token` propio para el Apps Script, y un `whatsapp_number` opcional.
- **Sesiones reales** en tabla `sessions` (token aleatorio, expiración 30 días), cookie
  `gastaker_auth` con la misma config actual. Login por email+password, logout real.
- **Invitaciones** (`invites`): **solo el admin** (flag `is_admin`, lo tiene el usuario
  del bootstrap) genera links de un solo uso; el invitado se registra con ese link. Los
  usuarios invitados NO pueden invitar a otros. No hay registro abierto.
- **Scoping por `user_id`** en las tres tablas de datos, con `db.forUser(userId)` que
  devuelve la API actual con el `user_id` fijado en todas las queries.
- **Ingesta y WhatsApp por usuario**: el header `X-Webhook-Secret` resuelve un
  `ingest_token → user`; el número entrante resuelve un `whatsapp_number → user`.
- **Frontend**: login por email, botón logout, página de Ajustes (token de ingesta +
  editar número + invitar) y página de registro.
- **Push de WhatsApp desactivado** (se elimina la llamada y sus env vars).

La migración es idempotente dentro de `createDb()` (patrón existente), y un script
`scripts/bootstrap-user.js` adopta los datos preexistentes para el primer usuario.

---

## Esquema de base de datos

### Tablas nuevas

```sql
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,          -- formato: "scrypt$<saltHex>$<hashHex>"
  ingest_token   TEXT    NOT NULL UNIQUE,   -- crypto.randomBytes(24).hex, para el Apps Script
  whatsapp_number TEXT   UNIQUE,            -- nullable; formato internacional sin '+'
  is_admin       INTEGER NOT NULL DEFAULT 0, -- 1 = puede generar invitaciones
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,          -- crypto.randomBytes(32).hex
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  TEXT    NOT NULL,             -- ISO; now + 30 días
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invites (
  token       TEXT    PRIMARY KEY,          -- crypto.randomBytes(24).hex
  created_by  INTEGER NOT NULL REFERENCES users(id),
  used_by     INTEGER REFERENCES users(id), -- nullable; NULL = sin usar
  expires_at  TEXT    NOT NULL,             -- ISO; now + 7 días
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Nota sobre `password_hash`: se guarda salt+hash juntos en un string
`scrypt$<saltHex>$<hashHex>`. La verificación re-deriva con el mismo salt y compara con
`crypto.timingSafeEqual`. Cero dependencias nuevas (todo `node:crypto`).

### Tablas de datos (esquema final, tras la migración)

```sql
-- expenses: se le agrega user_id; el UNIQUE simple de gmail_message_id pasa a compuesto.
CREATE TABLE expenses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER,               -- nullable a propósito (ver migración/bootstrap)
  gmail_message_id  TEXT    NOT NULL,
  amount            REAL    NOT NULL,
  merchant          TEXT    NOT NULL,
  category          TEXT    NOT NULL,
  card              TEXT,
  occurred_at       TEXT    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'ARS',
  source            TEXT    NOT NULL DEFAULT 'santander',
  needs_review      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_expenses_user_msg ON expenses(user_id, gmail_message_id);

-- comercios_conocidos: user_id + match único por usuario.
CREATE TABLE comercios_conocidos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  match       TEXT NOT NULL,
  category    TEXT NOT NULL,
  alias       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_comercios_user_match ON comercios_conocidos(user_id, match);

-- categories: user_id + name único (NOCASE) por usuario.
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  name        TEXT NOT NULL COLLATE NOCASE,
  color       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_categories_user_name ON categories(user_id, name);
```

**Decisión (UNIQUE compuestos): recrear las tablas con el "12-step dance", pero moviendo
los UNIQUE de la definición de columna a índices `CREATE UNIQUE INDEX` explícitos.**

Por qué así y no "dropear el índice viejo y crear uno nuevo": los tres UNIQUE actuales
están declarados *inline* en la columna (`gmail_message_id TEXT NOT NULL UNIQUE`, etc.),
lo que genera un `sqlite_autoindex_*` que **no se puede eliminar con `DROP INDEX`** — solo
recreando la tabla. Así que el dance es inevitable. Lo aprovechamos para: (a) agregar
`user_id`, (b) quitar el UNIQUE inline, y (c) crear en su lugar índices UNIQUE compuestos
manejables a futuro.

**Decisión (`user_id` nullable, no NOT NULL):** dejarlo nullable evita el problema del
huevo y la gallina en el backfill. Como en producción hoy no existe ningún usuario, al
migrar las filas existentes quedan con `user_id = NULL` (huérfanas). El scoping por
`forUser` filtra siempre `WHERE user_id = ?`, así que **las filas huérfanas quedan
invisibles hasta que el script de bootstrap les asigne dueño**. Esto es un buen "modo
seguro": si te olvidás de correr el bootstrap, no ves tus datos (señal clara), no hay
corrupción. Las inserciones normales via `forUser` siempre setean `user_id`, así que en
régimen nunca se crean NULLs nuevos.

---

## Plan de migración (dentro de `createDb`)

Todo idempotente, siguiendo el patrón actual de `PRAGMA table_info` + `cols.includes(...)`.

1. **Crear tablas nuevas** `users`, `sessions`, `invites` con `CREATE TABLE IF NOT EXISTS`.

2. **Migrar `expenses`** — solo si `PRAGMA table_info(expenses)` **no** incluye `user_id`:
   1. `PRAGMA foreign_keys = OFF`
   2. `BEGIN` (usar `sqlite.transaction(...)`)
   3. Asegurar primero las columnas viejas que puedan faltar (`currency`, `source`,
      `needs_review`) con los `ALTER TABLE ADD COLUMN` actuales — así el `SELECT` del
      copiado siempre encuentra las columnas.
   4. `CREATE TABLE expenses_new (...)` con el esquema final de arriba (con `user_id`,
      sin UNIQUE inline).
   5. `INSERT INTO expenses_new (id, user_id, gmail_message_id, amount, merchant,
      category, card, occurred_at, currency, source, needs_review, created_at)
      SELECT id, NULL, gmail_message_id, amount, merchant, category, card, occurred_at,
      currency, source, needs_review, created_at FROM expenses` (backfill `user_id = NULL`).
   6. `DROP TABLE expenses`
   7. `ALTER TABLE expenses_new RENAME TO expenses`
   8. `CREATE UNIQUE INDEX ux_expenses_user_msg ON expenses(user_id, gmail_message_id)`
   9. `COMMIT`
   10. `PRAGMA foreign_keys = ON`

3. **Migrar `comercios_conocidos`** — mismo dance si no tiene `user_id`. Backfill
   `user_id = NULL`. Índice `ux_comercios_user_match`.

4. **Migrar `categories`** — mismo dance si no tiene `user_id`. Backfill `user_id = NULL`.
   Índice `ux_categories_user_name`. **Eliminar el seed global de 8 categorías** de
   `createDb` (el seed pasa a ser por-usuario, ver `createUser`). Las categorías
   preexistentes quedan huérfanas y las adopta el bootstrap.

5. En `:memory:` (tests) nunca hay filas huérfanas: se crean las tablas nuevas directo
   con el esquema final (el branch de dance sobre tabla vacía corre igual, sin efectos).

### Bootstrap de datos preexistentes

**Decisión: script `scripts/bootstrap-user.js <email> <password>`, no env vars.**

Es el mecanismo más simple: cero env vars nuevas, cero lógica de hash dentro de `db.js`,
explícito e idempotente. Se corre una única vez en el deploy de esta versión.

```
node scripts/bootstrap-user.js gaston@ejemplo.com "mi-clave-larga"
```

El script:
1. Abre la DB (`createDb(DB_PATH)`), que ya corrió la migración estructural.
2. Si ya existe un usuario con ese email, no lo recrea (idempotente); usa el existente.
   Si no, `db.createUser({ email, password, isAdmin: true })` (hashea, genera `ingest_token`,
   seedea las 8 categorías default de ese usuario). **El usuario del bootstrap es el único
   admin**: es quien puede generar invitaciones.
3. `UPDATE expenses SET user_id = ? WHERE user_id IS NULL` (ídem `comercios_conocidos`).
4. Para `categories`: las categorías huérfanas preexistentes se re-asignan al usuario
   (evitando duplicar con las que `createUser` ya seedeó — si el nombre ya existe para el
   usuario, se descarta la huérfana; si no, se le pone el `user_id`). En la práctica los
   nombres coinciden con el seed, así que alcanza con borrar las huérfanas y quedarse con
   las seedeadas, **pero** conservando cualquier categoría custom que el usuario hubiera
   creado (nombre que no está en el seed → se le asigna `user_id`).
5. Imprime el `ingest_token` para pegar en el Apps Script.

El script se documenta en el README como paso obligatorio del deploy de esta versión.

---

## Endpoints

Auth = requiere cookie de sesión válida (`requireAuth`, setea `req.userId`).

| Método | Ruta | Auth | Body | Respuestas |
|--------|------|------|------|------------|
| POST | `/api/login` | no | `{ email, password }` | 200 `{ ok:true }` + cookie / 401 `{ error }` |
| POST | `/api/logout` | sí | — | 200 `{ ok:true }` + limpia cookie |
| GET | `/api/me` | sí | — | 200 `{ email, ingest_token, whatsapp_number, is_admin }` |
| PATCH | `/api/me` | sí | `{ whatsapp_number }` | 200 `{ ok:true, whatsapp_number }` / 409 `{ error }` (número en uso) / 400 |
| POST | `/api/invites` | sí (admin) | — | 201 `{ token, url, expires_at }` / 403 `{ error }` si no es admin |
| GET | `/api/invites/:token` | no | — | 200 `{ valid:true }` / 200 `{ valid:false, reason }` |
| POST | `/api/register` | no | `{ token, email, password }` | 201 `{ ok:true }` + cookie (auto-login) / 400 / 409 (email en uso) / 410 (invite inválido/vencido/usado) |
| GET | `/api/expenses?month=YYYY-MM` | sí | — | 200 `{ month, expenses, totals }` (scopeado) |
| PATCH | `/api/expenses/:id` | sí | `{ category, learn? }` | igual que hoy, scopeado |
| GET | `/api/categories` | sí | — | 200 `{ categories }` (scopeado) |
| POST | `/api/categories` | sí | `{ name, color }` | igual que hoy, scopeado |
| PATCH | `/api/categories/:id` | sí | `{ name?, color? }` | igual que hoy, scopeado |
| DELETE | `/api/categories/:id` | sí | — | igual que hoy, scopeado |
| POST | `/api/ingest` | token | header `X-Webhook-Secret: <ingest_token>` + `{ messageId, body, ... }` | 200 (scopeado al user del token) / 401 (token no resuelve) |
| POST | `/api/whatsapp` | firma | payload Kapso | 200 siempre; ignora si el número no matchea ningún `whatsapp_number` |

`GET /api/invites/:token` es público a propósito: la página de registro necesita saber si
el token es válido antes de mostrar el form, sin exponer datos sensibles (solo válido/inválido).

`reason` en invite inválido: `'not_found' | 'expired' | 'used'`.

---

## Cambios archivo por archivo

### `src/crypto.js` (nuevo)
Helpers con `node:crypto`, reutilizables por `db.js`, `register` y los scripts CLI:
- `hashPassword(plain)` → `"scrypt$<saltHex>$<hashHex>"` (salt `randomBytes(16)`, `scryptSync`).
- `verifyPassword(plain, stored)` → bool, re-deriva con el salt guardado y compara con
  `timingSafeEqual` (chequear largos antes para no tirar excepción).
- `randomToken(bytes = 24)` → `randomBytes(bytes).toString('hex')`.

### `src/db.js`
Refactor mayor. La API top-level deja de exponer `insert/list/...` directos y pasa a:

**Funciones de usuario / auth / invites (nivel raíz):**
- `createUser({ email, password, whatsappNumber = null, isAdmin = false })` → inserta user
  (hash + `ingest_token` via `crypto.js`), **seedea las 8 categorías default de ese usuario**
  (el seed que hoy es global se mueve acá, con `user_id`). Devuelve
  `{ id, email, ingest_token, whatsapp_number, is_admin }`. Lanza `DUP` si el email existe.
  `register` siempre crea con `isAdmin: false`; solo el bootstrap crea con `isAdmin: true`.
- `authenticate(email, password)` → user o `null` (usa `verifyPassword`).
- `getUserById(id)`, `getUserByEmail(email)`, `getUserByIngestToken(token)`,
  `getUserByWhatsappNumber(number)` (este último ignora `NULL`/vacío: nunca matchea huérfanos).
- `updateUser(id, { whatsappNumber })` → lanza `DUP` si el número ya está en otro user.
- `createSession(userId)` → `{ token, expires_at }` (30 días).
- `getSession(token)` → `{ user_id, expires_at }` si vigente; si vencida, la borra y
  devuelve `null`. **Limpieza oportunista:** en cada `getSession`, `DELETE FROM sessions
  WHERE expires_at < now`.
- `deleteSession(token)`.
- `createInvite(createdBy)` → `{ token, expires_at }` (7 días).
- `getInvite(token)` → `{ valid, reason? }` (chequea existencia, `used_by IS NULL`, no vencido).
- `useInvite(token, userId)` → marca `used_by` (transacción: fallar si ya usado).

**`forUser(userId)`** → objeto con **exactamente** la API actual, pero con `user_id`
fijado en toda query:
`insert, list, getExpense, resumenMes, listarGastos, compararMeses, pendientes,
findLearned, clasificarGasto, registrarComercio, listCategories, createCategory,
updateCategoryDef, deleteCategory`.

Puntos finos del scoping:
- `insert` agrega `user_id` al `INSERT`; el `INSERT OR IGNORE` sigue funcionando contra
  el índice compuesto `(user_id, gmail_message_id)`.
- `findLearned` filtra `WHERE user_id = ?`.
- `registrarComercio`: el `INSERT OR REPLACE` y el `UPDATE expenses ... LIKE` se scopean
  a `user_id`. El `INSERT OR REPLACE` debe respetar el índice compuesto (match por usuario).
- Las **cascadas por nombre de categoría** de `updateCategoryDef` y `deleteCategory`
  (los `UPDATE expenses SET category = ...` y `UPDATE/DELETE comercios_conocidos`)
  llevan `AND user_id = ?`. Un rename de "Comida" del user A **no** toca los gastos de B.
- La **protección de "Otros"** sigue igual pero es implícitamente por-usuario (cada user
  tiene su propia fila "Otros").
- `listCategories`: el subquery de `count` filtra `WHERE e.category = c.name AND e.user_id = ?`.

Mantener `_raw` (lo usan scripts/tests que operan sobre el sqlite directo).

### `src/auth.js`
- `loginHandler({ db })` → lee `{ email, password }`, `db.authenticate`, si ok
  `db.createSession(user.id)` y setea cookie `gastaker_auth` con el **mismo** config actual
  (`httpOnly`, `sameSite:'lax'`, `secure:req.secure`, `maxAge` 30 días) usando el token de
  sesión. 401 si falla.
- `logoutHandler({ db })` (nuevo) → `db.deleteSession(cookie)` + `res.clearCookie('gastaker_auth')`.
- `requireAuth({ db })` → lee cookie, `db.getSession(token)`; si vigente setea
  `req.userId = session.user_id` y `next()`; si no, 401. Ya no compara contra `config.sessionToken`.
- `requireAdmin({ db })` (nuevo) → corre después de `requireAuth`; si
  `db.getUserById(req.userId).is_admin` no es 1 → 403. Lo usa solo `POST /api/invites`.

### `src/app.js`
- Inyectar `db` (no `config`) donde hoy va `config` para auth.
- Registrar `POST /api/login` (con `db`), `POST /api/logout`, y un router `meRouter`
  (`GET/PATCH /api/me`) y `invitesRouter` (`POST /api/invites`, `GET /api/invites/:token`,
  `POST /api/register`). `register` vive junto a invites porque comparte lógica.
- `expensesRouter` y `categoriesRouter` pasan a recibir `db` y usar `requireAuth({ db })`;
  cada handler hace `const udb = db.forUser(req.userId)`.

### `src/routes/ingest.js`
- Reemplazar la comparación contra `config.webhookSecret` por:
  `const user = db.getUserByIngestToken(req.get('X-Webhook-Secret'))`; si no hay user → 401.
- Usar `const udb = db.forUser(user.id)` para `findLearned` e `insert`.
- **Eliminar** el bloque `avisarSinClasificar` y el import (push desactivado).

### `src/routes/whatsapp.js`
- Reemplazar `if (from !== config.allowedNumber) return` por
  `const user = db.getUserByWhatsappNumber(from); if (!user) return`.
- `const tools = buildTools(db.forUser(user.id))`.
- La memoria por número (`memory.load/save(from)`) queda igual.

### `src/agent/tools.js`
Sin cambios de lógica: ya recibe un `db` y llama sus métodos. Ahora se le pasa el objeto
de `forUser(userId)`, que expone la misma superficie.

### `src/routes/expenses.js` y `src/routes/categories.js`
- `requireAuth({ db })`. Cada handler: `const udb = db.forUser(req.userId)` y usar `udb.*`.

### `src/server.js`
- `config` queda: `kapsoWebhookSecret` (requerido), `anthropicModel`. Se van
  `webhookSecret`, `appPassword`, `sessionToken`, `allowedNumber`, `pushEnabled`,
  `notifyWhatsapp`.
- `createApp({ db, config })` sin cambios de firma.

### `src/agent/notifier.js`
**Decisión: se conserva el archivo pero no se invoca desde ingest.** Justificación: es
código funcional de una feature ya diseñada (push proactivo) que se reactiva cuando haya
plantilla de utilidad aprobada; borrarlo perdería trabajo útil y su test unit sigue verde.

### `apps-script/Code.gs`
- Renombrar la constante `WEBHOOK_SECRET` → `INGEST_TOKEN`, con comentario:
  `// Pegá acá tu Token de Ingesta (lo copiás desde Ajustes en la web)`.
- El header sigue siendo `X-Webhook-Secret` (su valor ahora es el `ingest_token`).

### `scripts/bootstrap-user.js` (nuevo)
Ver sección de bootstrap. `node scripts/bootstrap-user.js <email> <password>`.

### `scripts/reset-password.js` (nuevo)
`node scripts/reset-password.js <email> <nueva-password>` → busca el user, re-hashea con
`crypto.js`, `UPDATE users SET password_hash = ?`. Para emergencias. **No** hay create-user
por CLI (se reemplaza por invites; el único alta directa es el bootstrap).

### `.env.example` y `README.md`
- Quitar `APP_PASSWORD`, `SESSION_TOKEN`, `WEBHOOK_SECRET`, `NOTIFY_WHATSAPP`,
  `WHATSAPP_PUSH_ENABLED`.
- Quedan: `PORT`, `DB_PATH`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`,
  `KAPSO_WEBHOOK_SECRET`, `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`.
- README: documentar el flujo de bootstrap en el deploy, la sección de Apps Script pasa a
  hablar del Token de Ingesta desde Ajustes, y un párrafo de "invitar a alguien".

### Frontend

**`public/index.html`**
- Login: reemplazar el input único de password por dos campos: `email` (type=email,
  autocomplete username) + `password`. Ajustar el `#login-error` (mensaje "email o clave
  incorrectos").
- Menú hamburguesa: agregar links `Ajustes` (`/ajustes.html`) y un botón `Salir` (logout).

**`public/app.js`**
- El submit de login manda `{ email, password }`.
- Handler de logout: `POST /api/logout` → `showLogin()`.

**`public/ajustes.html` + `public/ajustes.js`** (nuevos, mismo estilo vanilla)
- Carga `GET /api/me`.
- Muestra el `ingest_token` en un campo readonly con botón "Copiar", más instrucciones
  cortas del Apps Script (pegar en `INGEST_TOKEN`).
- Campo editable de `whatsapp_number` → `PATCH /api/me` (feedback de éxito / 409 en uso).
- Botón "Invitar amigo" → `POST /api/invites` → muestra el `url` para copiar.
  **Solo se renderiza si `is_admin` es true en la respuesta de `/api/me`** (los invitados
  no ven la opción; el backend igual devuelve 403 si la llaman a mano).

**`public/registro.html` + `public/registro.js`** (nuevos)
- Lee `?token=` de la URL. `GET /api/invites/:token`: si `valid:false` muestra
  "invitación inválida o vencida"; si `valid:true` muestra el form email+password.
- Submit → `POST /api/register` → en éxito redirige a `/` (ya queda logueado por la cookie).
- El link generado en Ajustes apunta a `${location.origin}/registro.html?token=<token>`
  (query param: evita agregar routing server-side, sirve con `express.static`).

---

## Flujos de usuario

### Invitar a alguien (solo el admin)
1. El admin (vos) entra a Ajustes → "Invitar amigo". Los demás usuarios no ven el botón.
2. El front pega a `POST /api/invites`, recibe el `url` y lo muestra para copiar.
3. Le pasa el link a la persona (WhatsApp/mail). Vence en 7 días, un solo uso.

### Registrarse
1. La persona abre `…/registro.html?token=XXX`.
2. El front valida con `GET /api/invites/XXX`. Si vale, muestra el form.
3. Completa email+password → `POST /api/register`. Se crea el user, se marca el invite
   usado, se seedean sus 8 categorías, se genera su `ingest_token`, y queda logueado.
4. Cae en la app vacía; el próximo paso es Ajustes → configurar el Apps Script.

### Configurar el Apps Script
1. En Ajustes copia su Token de Ingesta.
2. Pega el `Code.gs` en script.google.com, completa `WEBHOOK_URL` y `INGEST_TOKEN`.
3. Autoriza y pone el trigger cada 5 min. Sus mails de Santander empiezan a caer scopeados
   a su usuario.

### (Opcional) WhatsApp
1. En Ajustes carga su `whatsapp_number`.
2. A partir de ahí, los mensajes desde ese número corren el agente sobre **sus** datos.

---

## Casos borde

- **Email duplicado** en register o bootstrap → 409 / el script reusa el existente.
- **whatsapp_number duplicado** al setear en `/api/me` → 409 (índice UNIQUE).
- **whatsapp_number NULL** (la mayoría) → `getUserByWhatsappNumber` nunca matchea NULL/vacío;
  un mensaje de un número no registrado se ignora (200 sin responder).
- **Invite ya usado / vencido / inexistente** → `GET` devuelve `valid:false` con `reason`;
  `POST /api/register` responde 410.
- **Sesión vencida** → `requireAuth` 401; `getSession` la borra + limpia todas las vencidas.
- **Colisión de `ingest_token`/`session token`** (astronómicamente improbable con
  randomBytes) → el UNIQUE/PK lo rechaza; regenerar y reintentar.
- **Datos huérfanos sin bootstrap** → invisibles vía `forUser` (no corrupción). Correr el
  script los hace aparecer.
- **Cascada de categoría cross-user**: rename/delete de "Comida" del user A no toca los
  gastos ni comercios de B (todas las cascadas llevan `AND user_id = ?`). **Este es el
  invariante crítico a testear.**
- **"Otros" por usuario**: cada user tiene su fila "Otros" protegida; borrar/renombrar la
  de A no afecta la de B.
- **Mismo `gmail_message_id` en dos usuarios** (dos Gmail distintos, teóricamente): el
  índice compuesto `(user_id, gmail_message_id)` permite coexistencia; la idempotencia
  sigue funcionando dentro de cada usuario.
- **Auto-login tras register**: se setea la cookie de sesión en la respuesta de register.
- **`categorize()` (reglas estáticas de código)** sigue siendo global: es lógica de matching
  de nombres, no datos de usuario. No se scopea. Solo `findLearned` (db-backed) se scopea.

---

## Plan de tests

### Tests existentes que se rompen y cómo se adaptan

Helper compartido nuevo (p.ej. `test/helpers.js`): `makeUserDb()` que crea `db =
createDb(':memory:')`, un usuario `db.createUser({ email, password })`, y devuelve
`{ db, user, udb: db.forUser(user.id) }`. Y `authedAgent(app, { email, password })` que
loguea por email+password.

- **`test/db.test.js`**: hoy usa `db.insert/list/...` directo. Migrar a `udb` de
  `makeUserDb()`. Los tests de categorías esperan el seed de 8 → ahora lo produce
  `createUser` (por usuario), así que `udb.listCategories()` sigue devolviendo las 8.
- **`test/ingest.test.js`**: el `CONFIG` con `webhookSecret` deja de aplicar. El helper crea
  un user y manda `X-Webhook-Secret: user.ingest_token`. Los asserts de inserción se
  verifican contra `db.forUser(user.id)`.
- **`test/expenses.test.js`**: `authedAgent` loguea con email+password (crear user antes).
  `seedExpense` usa el `ingest_token` del user. La lógica de los casos (learn, 404, etc.)
  no cambia.
- **`test/routes/categories.test.js`**: igual, auth por email+password.
- **`test/routes/whatsapp.test.js`**: `config.allowedNumber` deja de existir. Pasar un `db`
  real (`createDb(':memory:')`) con un user que tenga `whatsapp_number`; el número
  autorizado del test pasa a ser el de ese user. El caso "número no autorizado" usa un
  número sin user.
- **`test/agent/tools.test.js`**: `buildTools(db)` → `buildTools(db.forUser(user.id))`;
  el `seed` inserta via `udb`.
- **`test/agent/notifier.test.js`**: sin cambios (el notifier queda como unit aislado).

### Tests nuevos

- **`test/auth.test.js`**: login ok / email o password incorrectos → 401; cookie httpOnly;
  logout borra la sesión (un GET posterior a `/api/expenses` con esa cookie da 401);
  sesión vencida → 401 (crear sesión con `expires_at` en el pasado via `_raw` y verificar).
- **`test/invites.test.js`**: `POST /api/invites` requiere auth; **usuario no-admin → 403
  (un usuario creado vía register no puede invitar)**; `GET` devuelve
  `valid:true`; register consume el invite (segundo register con el mismo token → 410);
  invite vencido → 410; register sin token/ token inexistente → 410; register exitoso
  seedea 8 categorías y genera `ingest_token`; email duplicado → 409.
- **`test/isolation.test.js` (EL MÁS IMPORTANTE)**: dos usuarios A y B, cada uno con
  gastos y categorías. Verificar que:
  - `GET /api/expenses` de A no incluye gastos de B.
  - `PATCH /api/expenses/:id` de A sobre un id de B → 404.
  - `listCategories` de A es independiente de B.
  - rename/delete de "Comida" en A no cambia categorías/comercios de B.
  - `getUserByIngestToken` y el insert por ingest scopean correctamente.
- **`test/ingest-token.test.js`**: ingest con `ingest_token` de A inserta un gasto que solo
  ve A; token inválido → 401.
- **`test/whatsapp-number.test.js`**: `from` = `whatsapp_number` de A → corre el agente con
  `forUser(A)` (verificar via el `db` inyectado que la tool consultó los datos de A);
  número desconocido → ignora (200, sin `runAgent`, sin `send`).
- **`test/migration.test.js`**: construir a mano una DB con el **esquema viejo**
  (single-user: `expenses`/`comercios_conocidos`/`categories` con UNIQUE inline, sin
  `user_id`) usando `better-sqlite3` directo sobre un **archivo temporal** (en el scratchpad
  o `os.tmpdir()`), insertar filas, cerrar. Abrir con `createDb(path)` → verificar que la
  migración corrió (existe `user_id`, existen los índices compuestos, los datos siguen ahí
  con `user_id NULL` e invisibles vía `forUser`). Luego correr la lógica de bootstrap y
  verificar que los datos quedan asignados y visibles para el user. (Se necesita archivo
  porque `:memory:` no persiste entre conexiones y el esquema viejo hay que crearlo en una
  conexión previa.)

---

## Orden de implementación (etapas commiteables)

Cada etapa deja la suite verde y la app funcional.

1. **`src/crypto.js` + `test/crypto.test.js`.** Aislado, aditivo. No toca nada existente.
2. **Tablas y funciones de auth en `db.js` (aditivo).** Agregar `users`/`sessions`/`invites`
   y `createUser/authenticate/getUser*/createSession/getSession/deleteSession/createInvite/
   getInvite/useInvite`. **Todavía no** tocar las tablas de datos ni `forUser`. La API vieja
   sigue intacta → app y tests actuales no se rompen. Sumar `test/auth.test.js` y
   `test/invites.test.js` (a nivel db, sin rutas todavía).
3. **Scoping + rutas + auth (commit grande y atómico).** Migración de las 3 tablas
   (`user_id` + índices compuestos), implementar `forUser`, mover el seed de categorías a
   `createUser`. Refactor de `ingest.js`, `expenses.js`, `categories.js`, `whatsapp.js`,
   `auth.js` (login email/pw, logout, `requireAuth` por sesión), `app.js`, `server.js`.
   Adaptar **todos** los tests existentes (helpers `makeUserDb`/`authedAgent`). Sumar
   `test/isolation.test.js`, `test/ingest-token.test.js`, `test/whatsapp-number.test.js`.
   Al cerrar esta etapa el backend multi-user está completo y verde.
4. **Endpoints `/api/me` e `/api/invites`+`/api/register` (rutas HTTP).** Cablear los routers
   en `app.js`. Completar `test/invites.test.js` a nivel HTTP.
5. **Scripts CLI**: `scripts/bootstrap-user.js`, `scripts/reset-password.js` +
   `test/migration.test.js`.
6. **Frontend**: login email/pw + logout (`index.html`, `app.js`), `ajustes.html/js`,
   `registro.html/js`.
7. **Docs y limpieza**: `apps-script/Code.gs` (`INGEST_TOKEN`), `.env.example`, `README.md`,
   eliminar la invocación de push y las env vars muertas de `server.js`.

**Estimación honesta:** ~4-6 días para un solo dev. Es un feature grande (auth completa +
migración con recreación de tablas + invites + frontend nuevo), por encima del ideal de
1-3 días, pero el scope está cerrado y es indivisible como release (no tiene sentido
mergear "medio multi-user"). El orden por etapas permite ir commiteando sin romper la app;
la etapa 3 es la más pesada (~2 días) y conviene hacerla de una sola sentada porque toca
el contrato de `db.js` y todas las rutas a la vez.
