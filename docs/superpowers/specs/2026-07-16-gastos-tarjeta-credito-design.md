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
- Que el **débito real del resumen** (cuando Santander lo debita de la cuenta el
  mes siguiente) **sí entre y sume al total**. Hoy ese mail llega al servidor
  (el Apps Script reenvía todo lo del remitente) pero el parser lo descarta:
  no tiene etiqueta "Monto", así que `parseBody` devuelve `null`. Sin esto, el
  dinero de tarjeta no sumaría en ningún mes y el total quedaría subestimado.
- Fuera de alcance: agente de WhatsApp (`resumenMes`, `compararMeses` y demás
  quedan como están), ciclos de cierre, cuotas, conciliación de resúmenes.

## Mail del pago del resumen (formato real)

```
Información sobre el pago de tu tarjeta
Hola
Santander
Debitamos $987.357,33 de tu Cuenta en Pesos N° XXXX-2910 por el pago de tu Tarjeta SANTANDER VISA.

    Tarjeta    XXXX-XXX3967
    Saldo en pesos    $ 726.357,33
    Saldo en dólares    u$s 174,00
    Pago mínimo    $ 142.880,00
```

Se parsea así: monto = lo que sigue a "Debitamos" (el débito real de la cuenta,
incluye el saldo USD convertido a pesos); comercio = "Pago tarjeta SANTANDER
VISA"; tarjeta = últimos 4 dígitos de la línea "Tarjeta XXXX-XXX3967"; moneda
ARS; `type = 'Débito'` (es plata que sale de la cuenta: suma al total);
`kind = 'pago_tarjeta'`. El mail no trae Fecha/Hora: la ingesta usa
`receivedAt` (mecanismo existente). `isIgnored` no matchea este mail ("Saldo en
pesos" ≠ "importe en pesos"), así que no hay que tocarlo.

## Semántica

- El **total grande** pasa a ser "plata que salió (o va a salir ya) de la
  cuenta este mes": débito, transferencias, débitos automáticos y el pago del
  resumen de la tarjeta. El pago del resumen entra como gasto con categoría
  fija **"Tarjeta"** y suma al total y a la barra — no hay doble conteo porque
  los consumos con crédito individuales no suman.
- La categoría **"Tarjeta"** (color `#DC2626`, `excluded = 0`) se agrega a
  `DEFAULT_CATEGORIES` para usuarios nuevos y se backfillea una sola vez a los
  usuarios existentes dentro de la migración de `payment_method` (mismo patrón
  que "Movimientos internos" con `excluded`). Si el usuario la borra después,
  no se re-seedea.
- Los consumos en **USD con crédito** aparecen en la línea USD del mes de
  compra y, el mes siguiente, dentro del pago del resumen en pesos (Santander
  los convierte). Es una doble aparición informativa entre monedas distintas
  que nunca se suman entre sí: se acepta.
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
  (mismo patrón `PRAGMA table_info` que las migraciones existentes). La
  migración va DESPUÉS de crear la tabla `users` porque su backfill seedea la
  categoría "Tarjeta" a los usuarios existentes.
- Categoría "Tarjeta" (`#DC2626`, excluded 0) en `DEFAULT_CATEGORIES` +
  backfill dentro del `if` de la migración.
- `insertStmt` + `insert()`: aceptan `payment_method` con default `null`.

### 2. Parser (`src/sources/santander.js`)

- Caso nuevo `parsePagoTarjeta(text)`: detecta `Debitamos ... pago de tu
  Tarjeta`, extrae monto/tarjeta/marca según el formato de arriba y devuelve el
  shape normalizado con `kind = 'pago_tarjeta'`, `type = 'Débito'`,
  `occurredAt = null`. Se chequea después de `isIgnored` y antes del parseo
  genérico por "Monto".

### 3. Ingesta (`src/routes/ingest.js`)

- Persistir `parsed.type` como `payment_method` en el `insert()`. Sin cambios
  de parsing: el dato ya viene en el resultado de `parseEmail`.
- Rama nueva de categorización: `kind === 'pago_tarjeta'` → categoría fija
  `'Tarjeta'`, `needs_review = 0` (determinístico, como las transferencias).

### 4. API (`src/routes/expenses.js`)

- `GET /api/expenses` ya hace `SELECT *`, así que `payment_method` viaja solo.
- El objeto `totals` de la respuesta excluye también los gastos con
  `payment_method = 'Crédito'` (misma semántica que el frontend).

### 5. Frontend (`public/app.js`, `public/index.html`, `public/styles.css`)

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

- `db`: `insert()` persiste `payment_method`; default `null` si no viene. El
  seed de usuario nuevo incluye "Tarjeta" con `excluded = 0`.
- Migración: abrir una base con esquema viejo (sin la columna) no rompe, la
  agrega y seedea "Tarjeta" a los usuarios existentes; correr dos veces es
  no-op.
- Parser: el mail real del pago del resumen (fixture de arriba) parsea monto
  987357.33, merchant "Pago tarjeta SANTANDER VISA", card "3967", ARS,
  `kind = 'pago_tarjeta'`, `type = 'Débito'`, `occurredAt = null`. Los mails de
  consumo/transferencia existentes no cambian de resultado.
- Ingesta: un mail de consumo crédito guarda `payment_method = 'Crédito'`; uno
  de débito, `'Débito'`. Se persiste tal cual lo que devuelva `parseType` (una
  transferencia puede dar `null` o `'Débito'` según el texto del mail; ambas
  suman al total, así que da igual). El mail del pago del resumen queda con
  categoría "Tarjeta" y suma al total.
- API: `totals` de `GET /api/expenses` no incluye los montos con crédito.

## Qué NO se hace (YAGNI)

- Nada de tarjetas como entidad, fechas de cierre, ciclos ni cuotas.
- El agente de WhatsApp no cambia (`resumenMes` sigue sumando todo): si más
  adelante se retoma, se alinea en otra iteración.
- No se intenta backfillear el `payment_method` de gastos históricos.
- No se re-ingestan los mails de pago de resumen viejos: el Apps Script ya los
  etiquetó como procesados (la ingesta respondió 200 con `skipped`). Si se
  quiere el del mes actual, se le saca la etiqueta `gastaker-procesado` al
  thread en Gmail y el próximo sync lo reenvía.
