# Carga manual de gastos

**Fecha:** 2026-07-21
**Estado:** aprobado (diseño validado en conversación)

## Problema

Hoy los gastos entran únicamente por la ingesta de mails de Santander. Todo lo
que no genera un mail — efectivo, Mercado Pago, otra tarjeta u otro banco, o un
gasto que la ingesta se perdió — queda afuera y el total del mes miente. No hay
forma de registrar un gasto a mano desde la app.

## Qué se quiere

- Un botón **`+`** en el header de Movimientos que abre un **popover** (mismo
  patrón visual que el popover de categorías) con tres campos: **monto**,
  **comercio** y **categoría**. Nada más: la fecha es siempre "ahora", la
  moneda ARS y el gasto cuenta como débito (suma al total del mes).
- Poder **borrar** un gasto cargado a mano si salió mal (monto tipeado mal,
  duplicado). Los gastos que vienen del mail no se pueden borrar.
- Distinguir en el ledger los gastos manuales con un badge chico **"manual"**.
- Fuera de alcance: agente de WhatsApp, edición de gastos, fecha/moneda/medio
  de pago editables.

## Semántica

- Un gasto manual es una fila más de `expenses`, indistinguible para todos los
  cálculos existentes (total, barra, leyenda, filtros, agente): suma al total
  como cualquier débito.
- `source = 'manual'` es lo que habilita el borrado y el badge.
- `payment_method = NULL`: cuenta como débito en los totales (regla existente
  para el histórico). Correcto para efectivo/MP: es plata que ya salió.
- Monto **negativo permitido** (compensaciones), cero no.
- **Sin cambios de esquema**: `gmail_message_id` es NOT NULL con UNIQUE por
  `(user_id, gmail_message_id)`, así que cada gasto manual recibe un id
  sintético `manual-<token>` (con `randomToken(12)` de `src/crypto.js`), que
  nunca colisiona con un message id real de Gmail.

## Cambios

### 1. DB (`src/db.js`)

- Método nuevo en `forUser`: `deleteExpense(id)` — `DELETE FROM expenses WHERE
  id = ? AND user_id = ?`. Devuelve `true` si borró. El chequeo de
  `source = 'manual'` lo hace la ruta (con `getExpense`, que ya existe), no la
  db: el método queda genérico y scopeado.
- `insert()` pasa a devolver también el id de la fila insertada:
  `{ inserted, id: info.lastInsertRowid }` (`id` solo tiene sentido cuando
  `inserted = true`; los llamadores existentes solo miran `inserted`, así que
  no se rompe nada). La ruta lo necesita para responder con la fila creada.

### 2. API (`src/routes/expenses.js`)

- **`POST /api/expenses`** con body `{ amount, merchant, category }`:
  - `amount`: se valida con `Number.isFinite()` y ≠ 0 → 400 si no.
  - `merchant`: trim, no vacío → 400 si no.
  - `category`: debe existir en las categorías del usuario (comparación
    case-insensitive contra `listCategories()`; se guarda el nombre canónico
    de la db) → 400 si no existe.
  - Inserta con: `gmail_message_id = 'manual-' + randomToken(12)`,
    `source = 'manual'`, `occurred_at = new Date().toISOString().slice(0, 19)`
    (mismo formato que la ingesta), `card = null`, `payment_method = null`,
    `currency = 'ARS'`, `needs_review = 0`.
  - Responde 201 con la fila creada (`getExpense` del id insertado).
- **`DELETE /api/expenses/:id`**:
  - `getExpense(id)` → 404 si no existe o no es del usuario.
  - `source !== 'manual'` → 400 ("solo se pueden borrar gastos manuales").
  - Si pasa, `deleteExpense(id)` → `{ ok: true }`.

### 3. Frontend (`public/index.html`, `public/app.js`, `public/styles.css`)

- **Botón `+`** en `.ledger-head`, junto al filtro de categorías (estilo
  `.step`, como los botones de mes).
- **Popover de alta**: reusa el elemento `#catmenu` y `positionMenu()` /
  `closeMenu()` existentes; el contenido es un mini form con:
  - monto: `<input inputmode="decimal">` con foco inicial,
  - comercio: `<input type="text">`,
  - categoría: `<select>` con las categorías del usuario (primera
    seleccionada por defecto),
  - botón "Agregar".
  - Los clicks/submits dentro del form frenan la propagación para que el
    listener global de `closeMenu` no lo cierre al tocar un input.
  - Submit → `POST /api/expenses` → cerrar popover y `load()`. Error → mensaje
    inline dentro del popover (sin `alert`).
- **Badge "manual"**: en las filas con `e.source === 'manual'`, junto al
  comercio (mismo patrón que el badge "crédito").
- **Borrado**: en `openCatMenu()`, si el gasto es manual, se agrega al final
  del popover una opción "Eliminar gasto" (estilo destructivo). Click →
  `confirm()` → `DELETE /api/expenses/:id` → `load()`.

## Tests (`test/manual-expense.test.js`)

- POST crea el gasto: aparece en `GET /api/expenses` del mes, suma al total,
  `source = 'manual'`, `payment_method = null`, `gmail_message_id` con prefijo
  `manual-`.
- Validaciones del POST: monto no numérico / cero → 400; comercio vacío → 400;
  categoría inexistente → 400. Categoría con otra capitalización ("comida") se
  acepta y guarda el nombre canónico.
- Dos POST idénticos crean dos gastos (ids sintéticos distintos, no los pisa
  el UNIQUE).
- Monto negativo se acepta y resta del total.
- DELETE de un gasto manual: lo saca del listado, `{ ok: true }`.
- DELETE de un gasto con `source = 'santander'` → 400.
- DELETE de un gasto de otro usuario o inexistente → 404.
- Sin sesión: POST y DELETE → 401 (via `requireAuth`).

## Qué NO se hace (YAGNI)

- No se editan gastos (ni manuales ni de mail): para corregir, se borra y se
  carga de nuevo.
- No hay fecha, moneda ni medio de pago editables en el form.
- No se borran gastos que vinieron del mail.
- El agente de WhatsApp no cambia: registrar gastos por chat queda para otra
  iteración si se quiere.
- No se aprende comercio→categoría desde el alta manual (el popover de
  recategorización existente ya cubre eso si hace falta).
