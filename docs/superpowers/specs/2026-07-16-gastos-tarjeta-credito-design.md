# Gastos con tarjeta de crédito: acumulado aparte, fuera del total

**Fecha:** 2026-07-16
**Estado:** aprobado (diseño validado en conversación)

## Problema

Los consumos con tarjeta de crédito se registran como cualquier gasto y suman al
total del mes, pero esa plata recién sale de la cuenta el mes siguiente (cuando
Santander debita el resumen). Hoy no se puede distinguir un consumo con crédito
de uno con débito: el parser de Santander ya detecta el tipo (`parseType` en
`src/sources/santander.js` devuelve `'Crédito'` / `'Débito'` / `null`), pero la
ingesta lo descarta porque la tabla `expenses` no tiene dónde guardarlo.

## Qué se quiere

- Saber **cuánto de tarjeta (crédito) voy gastando en el mes**.
- Que esos montos **no sumen al total** del mes: se muestran como línea aparte
  en el header, igual que hoy se muestran los USD.
- Fuera de alcance: agente de WhatsApp (`resumenMes`, `compararMeses` y demás
  quedan como están), ciclos de cierre, cuotas, conciliación de resúmenes.

## Semántica

- El **total grande** pasa a ser "plata que salió (o va a salir ya) de la
  cuenta este mes": débito, transferencias y débitos automáticos. Cuando el mes
  siguiente Santander debita el resumen de la tarjeta, ese débito automático
  entra como gasto normal y sí suma — no hay doble conteo.
- La línea **"Tarjeta"** es el acumulado ARS de consumos con crédito del mes en
  curso (informativo, devengado).
- La **barra de categorías y la leyenda** excluyen los consumos con crédito
  (misma regla que el total: barra = total grande). Decisión explícita del
  usuario: consistencia sobre desglose devengado.
- Los **USD no cambian**: la línea USD sigue sumando todos los gastos en USD
  del mes, sin importar el medio de pago.
- **Anulaciones** con crédito (monto negativo) restan de la línea Tarjeta, no
  del total.
- **Datos históricos**: las filas viejas quedan con `payment_method = NULL` y
  se tratan como débito (siguen sumando al total). Los meses pasados no cambian
  de significado.

## Cambios

### 1. Esquema (`src/db.js`)

- Columna nueva en `expenses`: `payment_method TEXT` (nullable). Valores:
  `'Crédito'`, `'Débito'`, `NULL` (desconocido/histórico).
- En `expensesSchema` (bases nuevas) y migración idempotente para bases
  existentes: `ALTER TABLE expenses ADD COLUMN payment_method TEXT` si falta
  (mismo patrón `PRAGMA table_info` que las migraciones existentes).
- `insertStmt` + `insert()`: aceptan `payment_method` con default `null`.

### 2. Ingesta (`src/routes/ingest.js`)

- Persistir `parsed.type` como `payment_method` en el `insert()`. Sin cambios
  de parsing: el dato ya viene en el resultado de `parseEmail`.

### 3. API (`src/routes/expenses.js`)

- `GET /api/expenses` ya hace `SELECT *`, así que `payment_method` viaja solo.
- El objeto `totals` de la respuesta excluye también los gastos con
  `payment_method = 'Crédito'` (misma semántica que el frontend).

### 4. Frontend (`public/app.js`, `public/index.html`, `public/styles.css`)

- `render()`: nuevo predicado `esCredito(e)` (`e.payment_method === 'Crédito'`).
  - `arsTotal`: excluye crédito (además de `EXCLUDED` como hoy).
  - Barra y leyenda: excluyen crédito.
  - Acumulado nuevo: `tarjetaTotal` = suma ARS de crédito no-excluido del mes.
- Header (`index.html`): línea `#total-tarjeta` debajo de `#total-usd`, con el
  formato "Tarjeta: $185.000". Oculta si el acumulado es 0 (mismo
  mostrar/ocultar que `#total-usd`).
- Ledger: los gastos con crédito muestran un badge "crédito" junto a la
  tarjeta (`•1458`) y usan el mismo estilo atenuado que las categorías
  excluidas (se ven, no suman).

## Tests

- `db`: `insert()` persiste `payment_method`; default `null` si no viene.
- Migración: abrir una base con esquema viejo (sin la columna) no rompe y la
  agrega; correr dos veces es no-op.
- Ingesta: un mail de consumo crédito guarda `payment_method = 'Crédito'`; uno
  de débito, `'Débito'`. Se persiste tal cual lo que devuelva `parseType` (una
  transferencia puede dar `null` o `'Débito'` según el texto del mail; ambas
  suman al total, así que da igual).
- API: `totals` de `GET /api/expenses` no incluye los montos con crédito.

## Qué NO se hace (YAGNI)

- Nada de tarjetas como entidad, fechas de cierre, ciclos ni cuotas.
- El agente de WhatsApp no cambia (`resumenMes` sigue sumando todo): si más
  adelante se retoma, se alinea en otra iteración.
- No se intenta backfillear el `payment_method` de gastos históricos.
