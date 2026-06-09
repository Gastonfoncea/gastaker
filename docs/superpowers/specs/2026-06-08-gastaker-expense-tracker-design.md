# Gastaker — Tracker automático de gastos desde Gmail (Santander)

**Fecha:** 2026-06-08
**Estado:** Diseño aprobado para escribir plan de implementación

## Problema

Cada vez que el usuario gasta con su tarjeta Santander (Argentina), le llega un mail de
aviso a su Gmail. Hoy esa información queda enterrada en la bandeja de entrada. El usuario
quiere que esos gastos se **anoten automáticamente**, se **categoricen**, y pueda **verlos y
trackearlos** en una web propia.

## Objetivo

Una app personal, de un solo usuario, que:

1. Detecte los mails de gasto de Santander apenas llegan (revisando cada pocos minutos).
2. Extraiga monto, comercio, fecha/hora y tarjeta de cada mail.
3. Le asigne una categoría según el comercio.
4. Los guarde sin duplicar.
5. Los muestre en una web simple, con total por categoría, filtro por mes, y la posibilidad
   de corregir la categoría de un gasto con un click.

## No-objetivos (YAGNI)

- Multiusuario / cuentas de otras personas.
- Múltiples bancos (por ahora solo Santander Argentina).
- Presupuestos, alertas, exportaciones, app móvil.
- Tiempo real al segundo (cada pocos minutos alcanza).
- Categorización con IA (se puede sumar después; arrancamos con reglas).

## Contexto del mail real (insumo de parseo)

**Remitente:** `Aviso Santander <mensajesyavisos@mails.santander.com.ar>` (Santander Argentina)

**Cuerpo (estructura etiqueta → valor):**

```
Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/06/2026

Hora
19:12
```

**Reglas de extracción:**

| Campo     | Origen                                   | Transformación                                  |
|-----------|------------------------------------------|-------------------------------------------------|
| `monto`   | línea siguiente a la etiqueta `Monto`    | `$12.946,00` → quitar `$`, quitar `.`, `,`→`.` → `12946.00` (número) |
| `comercio`| línea siguiente a la etiqueta `Comercio` | trim, mayúsculas tal cual                       |
| `fecha`   | línea siguiente a `Fecha` (`DD/MM/AAAA`) | combinar con hora                               |
| `hora`    | línea siguiente a `Hora` (`HH:MM`)       | combinar con fecha → timestamp ISO              |
| `tarjeta` | texto `terminada en NNNN` + tipo (`Débito`/`Crédito`) | guardar `Débito ••1458`             |

El parser se basa en la **estructura etiqueta→valor**, no en posiciones de whitespace fijas,
para tolerar variaciones de formato del mail.

> Pendiente menor: el usuario aún no pasó el **asunto** exacto del mail. El filtro principal es
> por remitente; el asunto, si se obtiene, se usa para afinar. Mientras tanto, además del
> remitente se valida que el cuerpo contenga las etiquetas `Monto` y `Comercio`.

## Arquitectura

Dos partes:

```
┌─ Cuenta Google del usuario ─────┐         ┌─ VPS del usuario ────────────────┐
│  Google Apps Script             │         │  Node.js + Express (1 proceso)   │
│   trigger de tiempo c/ ~3 min   │         │   POST /api/ingest               │
│   busca mails de Santander  ────┼──POST──▶ │     valida secreto               │
│   (from: mensajesyavisos@…)     │ webhook  │     parsea → categoriza → guarda │
│   marca cada mail "procesado"   │ +secreto │   GET  /api/expenses (lista)     │
│   (etiqueta Gmail)              │         │   PATCH /api/expenses/:id (recat) │
└─────────────────────────────────┘         │   sirve la web UI                │
                                             │   SQLite (better-sqlite3)        │
                                             └──────────────┬───────────────────┘
                                                            │  navegador
                                              Lista de gastos, total por categoría,
                                              filtro por mes, recategorizar (click)
```

### Por qué Apps Script para la ingesta (decisión clave)

Que el backend lea Gmail directo requiere el scope **restringido** `gmail.readonly`. Sin
verificación de Google (trámite pesado, orientado a empresas), la app queda en modo "testing"
y **el token se vence cada 7 días** → se rompería semanalmente. Inaceptable para algo que debe
correr solo siempre.

Google Apps Script corre **dentro de la cuenta del usuario, como el usuario**, con acceso nativo
a Gmail, **sin verificación y sin tokens que expiran**. Es una función oficial de Google; leer
el propio Gmail no tiene riesgo de bloqueo de cuenta. El VPS queda desacoplado de la Gmail API.

## Componentes (VPS)

Cada módulo con una sola responsabilidad y testeable de forma aislada.

1. **`parser`** — `(textoDelMail) → {monto, comercio, fecha, hora, tarjeta, tipo}`.
   Funciona sobre el texto; sin dependencias de red ni DB. Cubre el formato uruguayo/argentino
   de monto. Tests unitarios con el mail de ejemplo y variantes (crédito vs débito).

2. **`categorizer`** — `(comercio) → categoria`. Tabla de reglas (substring/keyword → categoría),
   editable en un archivo de config. Default `Otros` si nada matchea. Tests con casos conocidos
   (`VERDULERIA` → `Comida`, etc.).

3. **`db`** — capa SQLite (`better-sqlite3`). Esquema:

   ```sql
   CREATE TABLE expenses (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     gmail_message_id  TEXT    NOT NULL UNIQUE,   -- dedup
     amount            REAL    NOT NULL,
     merchant          TEXT    NOT NULL,
     category          TEXT    NOT NULL,
     card              TEXT,                       -- "Débito ••1458"
     occurred_at       TEXT    NOT NULL,           -- ISO timestamp (fecha+hora)
     created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
   );
   ```

   `gmail_message_id UNIQUE` garantiza que el mismo mail nunca se anote dos veces, aunque el
   webhook llegue repetido.

4. **`routes/ingest`** — `POST /api/ingest`. Valida el header de secreto compartido; toma
   `{messageId, subject, body, receivedAt}`; llama parser → categorizer → db. Responde idempotente
   (si el `messageId` ya existe, 200 sin insertar de nuevo).

5. **`routes/expenses`** — `GET /api/expenses?month=YYYY-MM` (lista + totales por categoría) y
   `PATCH /api/expenses/:id` (cambiar categoría a mano).

6. **`web` (UI)** — frontend liviano servido por el mismo Express (sin framework pesado):
   lista de gastos, total por categoría del mes, selector de mes, y dropdown/click para
   recategorizar. Protegida por contraseña.

7. **`auth`** — contraseña simple guardada como variable de entorno; la web la pide una vez
   (sesión/cookie). Upgrade futuro a login con Google cuando haya dominio.

## Componente Apps Script (lado Google)

Archivo corto que el usuario pega en `script.google.com`, autoriza una vez, y le pone un
**trigger de tiempo cada ~3 min**. En cada corrida:

1. Busca mails: `from:mensajesyavisos@mails.santander.com.ar` sin la etiqueta `gastaker-procesado`.
2. Para cada uno: `POST` a `https://<vps>/api/ingest` con header `X-Webhook-Secret: <secreto>`
   y body `{messageId, subject, body, receivedAt}`.
3. Si el POST responde OK, le agrega la etiqueta `gastaker-procesado` para no reenviarlo.

Doble protección anti-duplicados: la etiqueta del lado Google + el `UNIQUE` del lado VPS.

## Flujo de datos (end-to-end)

1. Llega mail de gasto a Gmail.
2. En ≤3 min, el Apps Script lo detecta y lo POSTea al VPS.
3. `/api/ingest` valida secreto → parsea → categoriza → inserta (o ignora si ya existe).
4. Apps Script etiqueta el mail como procesado.
5. El usuario abre la web y ve el gasto ya anotado y categorizado; si la categoría no le
   convence, la corrige con un click.

## Manejo de errores

- **Secreto inválido en `/api/ingest`** → 401, no procesa.
- **Mail que no matchea el formato** (sin `Monto`/`Comercio`) → el parser devuelve `null`; la
  ruta responde 200 con `skipped: true` y **no** etiqueta como procesado del lado Script (para
  poder reintentar tras un fix) — o lo loguea para inspección. (Decisión a refinar en el plan.)
- **`messageId` duplicado** → respuesta idempotente 200, sin doble inserción.
- **VPS caído** → el Apps Script no etiqueta el mail (POST falla); reintenta en la próxima
  corrida. Nada se pierde.
- **Monto/fecha imparseables** → se loguea el mail crudo para diagnóstico; no se inserta basura.

## Testing

- **`parser`**: unit tests con el mail real + variantes (crédito, montos con/sin decimales,
  comercios con caracteres raros). Es el módulo más crítico.
- **`categorizer`**: unit tests de reglas y del default `Otros`.
- **`db`**: test de que el `UNIQUE` impide duplicados.
- **`/api/ingest`**: test de integración (secreto inválido → 401; mail válido → inserta;
  mismo `messageId` dos veces → una sola fila).

## Stack y deploy

- **Runtime:** Node.js, Express, `better-sqlite3`. Un solo proceso.
- **Persistencia:** un archivo SQLite en el VPS.
- **Proceso siempre prendido:** `pm2` o `systemd` (se define en el plan/al desplegar).
- **Config (variables de entorno):** `WEBHOOK_SECRET`, `APP_PASSWORD`, `PORT`, ruta del archivo
  SQLite.
- **Apps Script:** se entrega como archivo `.gs` con instrucciones de pegado, autorización y
  configuración del trigger.

## Decisiones tomadas (resumen)

| Tema              | Decisión                                                        |
|-------------------|-----------------------------------------------------------------|
| Dónde se ve       | App web propia                                                  |
| Inmediatez        | Cada ~3 min (no tiempo real)                                    |
| Categorización    | Reglas por comercio, default `Otros`, recategorizar a mano      |
| Lectura de Gmail  | Google Apps Script → webhook (robusto, sin expiración de token) |
| Hosting           | VPS del usuario                                                 |
| Base de datos     | SQLite (`better-sqlite3`)                                       |
| Auth de la web    | Contraseña simple (env var); Google login como upgrade futuro   |
| Banco             | Solo Santander Argentina por ahora                              |

## Pendientes menores (no bloquean el plan)

- Asunto exacto del mail (para afinar el filtro; hoy se filtra por remitente + contenido).
- Lista inicial de reglas de categorización (se arma con los comercios habituales del usuario).
- Elección final entre `pm2` y `systemd` (al momento de desplegar).
