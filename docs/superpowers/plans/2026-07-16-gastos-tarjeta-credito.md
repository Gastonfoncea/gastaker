# Gastos con Tarjeta de Crédito Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistir el medio de pago (Crédito/Débito) de cada gasto y mostrar el acumulado de crédito del mes como línea aparte en el header, excluido del total, la barra y la leyenda.

**Architecture:** El parser de Santander (`src/sources/santander.js`) ya devuelve `type: 'Crédito' | 'Débito' | null`; hoy se descarta en la ingesta. Se agrega una columna nullable `payment_method` a `expenses` (migración idempotente estilo `ALTER TABLE ... ADD COLUMN`, mismo patrón que `excluded` en categories), la ingesta la persiste, y el frontend (vanilla JS) trata los gastos con `payment_method === 'Crédito'` como un bucket aparte, igual que hace con USD. Spec: `docs/superpowers/specs/2026-07-16-gastos-tarjeta-credito-design.md`.

**Tech Stack:** Node ESM, express, better-sqlite3, vitest + supertest. Frontend vanilla JS sin framework ni tests automatizados.

## Global Constraints

- Valores de `payment_method`: `'Crédito'`, `'Débito'`, `NULL` (histórico/desconocido; a efectos de totales, NULL = débito, sigue sumando).
- Copy exacto de UI: la línea del header dice `Tarjeta: $…`; el badge del ledger dice `crédito`.
- Los USD no cambian: la línea USD sigue sumando todo, sin importar medio de pago.
- El agente de WhatsApp NO se toca (`resumenMes`, `compararMeses`, etc. quedan como están).
- Todos los tests corren con `npx vitest run <archivo>` (suite completa: `npm test`).
- Comentarios y mensajes de commit en español, siguiendo el estilo del repo.

---

### Task 1: Columna `payment_method` en la DB

**Files:**
- Modify: `src/db.js` (expensesSchema línea ~22, migraciones línea ~168, insertStmt línea ~182, insert() línea ~219)
- Create: `test/payment-method.test.js`

**Interfaces:**
- Produces: `udb.insert(record)` acepta `payment_method` (string o null, default null); las filas de `udb.list(month)` y `udb.getExpense(id)` traen `payment_method`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/payment-method.test.js`:

```js
// test/payment-method.test.js — medio de pago (Crédito/Débito) en expenses.
// Los consumos con crédito no suman al total del mes: se debitan el mes siguiente.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDb } from '../src/db.js'
import { makeUserDb } from './helpers.js'

const gasto = (over = {}) => ({
  gmail_message_id: `m-${Math.random()}`,
  amount: 100,
  merchant: 'X',
  category: 'Comida',
  occurred_at: '2026-07-01T10:00:00',
  ...over,
})

describe('columna payment_method', () => {
  it('insert() persiste payment_method y defaultea a null', () => {
    const { udb } = makeUserDb()
    udb.insert(gasto({ gmail_message_id: 'm-cred', payment_method: 'Crédito' }))
    udb.insert(gasto({ gmail_message_id: 'm-deb', payment_method: 'Débito' }))
    udb.insert(gasto({ gmail_message_id: 'm-sin' }))
    const rows = udb.list('2026-07')
    expect(rows.find((r) => r.gmail_message_id === 'm-cred').payment_method).toBe('Crédito')
    expect(rows.find((r) => r.gmail_message_id === 'm-deb').payment_method).toBe('Débito')
    expect(rows.find((r) => r.gmail_message_id === 'm-sin').payment_method).toBeNull()
  })
})

describe('migración: DB multi-user previa sin payment_method', () => {
  let dbPath
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix
      if (existsSync(f)) unlinkSync(f)
    }
  }

  // Réplica del esquema ANTERIOR a este feature (expenses sin payment_method).
  function seedPreFeatureDb(path) {
    const sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.exec(`
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, gmail_message_id TEXT NOT NULL,
        amount REAL NOT NULL, merchant TEXT NOT NULL, category TEXT NOT NULL, card TEXT,
        occurred_at TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'ARS',
        source TEXT NOT NULL DEFAULT 'santander', needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE comercios_conocidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, match TEXT NOT NULL,
        category TEXT NOT NULL, alias TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX ux_expenses_user_msg ON expenses(user_id, gmail_message_id);
      CREATE UNIQUE INDEX ux_comercios_user_match ON comercios_conocidos(user_id, match);
      CREATE UNIQUE INDEX ux_categories_user_name ON categories(user_id, name);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, ingest_token TEXT NOT NULL UNIQUE,
        whatsapp_number TEXT UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    sqlite.prepare('INSERT INTO users (id, email, password_hash, ingest_token) VALUES (1, ?, ?, ?)')
      .run('gaston@test.com', 'scrypt$x$y', 'tok-1')
    sqlite.prepare(`
      INSERT INTO expenses (user_id, gmail_message_id, amount, merchant, category, occurred_at)
      VALUES (1, 'm-viejo', 1000, 'VERDULERIA', 'Comida', '2026-07-01T10:00:00')
    `).run()
    sqlite.close()
  }

  beforeEach(() => {
    dbPath = join(tmpdir(), `gastaker-paymethod-${process.pid}-${Date.now()}.db`)
    cleanup()
    seedPreFeatureDb(dbPath)
  })
  afterEach(cleanup)

  it('agrega la columna; las filas viejas quedan en NULL', () => {
    const db = createDb(dbPath)
    const cols = db._raw.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name)
    expect(cols).toContain('payment_method')
    const viejo = db.forUser(1).list('2026-07').find((r) => r.gmail_message_id === 'm-viejo')
    expect(viejo.payment_method).toBeNull()
  })

  it('es idempotente: correr createDb dos veces no rompe', () => {
    createDb(dbPath)._raw.close()
    const db = createDb(dbPath)
    expect(db.forUser(1).list('2026-07')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/payment-method.test.js`
Expected: FAIL — el primer test falla (el expect da `undefined` en vez de `'Crédito'`, o better-sqlite3 tira error de bind por el parámetro extra — cualquiera de los dos vale como rojo). Los de migración fallan porque la columna no aparece en `PRAGMA table_info`.

- [ ] **Step 3: Implementar en `src/db.js`**

3a. En `expensesSchema`, agregar la columna después de `card`:

```js
const expensesSchema = (name) => `
  CREATE TABLE ${name} (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER,
    gmail_message_id  TEXT    NOT NULL,
    amount            REAL    NOT NULL,
    merchant          TEXT    NOT NULL,
    category          TEXT    NOT NULL,
    card              TEXT,
    payment_method    TEXT,
    occurred_at       TEXT    NOT NULL,
    currency          TEXT    NOT NULL DEFAULT 'ARS',
    source            TEXT    NOT NULL DEFAULT 'santander',
    needs_review      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`
```

OJO: la migración multi-user de `expenses` (el "12-step dance") copia columnas por
lista explícita en su `INSERT INTO expenses_new (...) SELECT ...`, así que agregar
la columna al schema no la rompe: en ese caso `payment_method` queda NULL. NO tocar
ese bloque.

3b. Después del bloque de migración de `expenses` a multi-user (después de la línea `sqlite.pragma('foreign_keys = ON')` de ese bloque, ~línea 101), agregar:

```js
  // --- Migración: payment_method en expenses (idempotente) ---
  // 'Crédito' | 'Débito' | NULL. NULL (histórico) cuenta como débito en los totales.
  if (!sqlite.prepare('PRAGMA table_info(expenses)').all().some((c) => c.name === 'payment_method')) {
    sqlite.exec('ALTER TABLE expenses ADD COLUMN payment_method TEXT')
  }
```

3c. Actualizar `insertStmt`:

```js
  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (user_id, gmail_message_id, amount, merchant, category, card, payment_method, occurred_at, currency, source, needs_review)
    VALUES
      (@user_id, @gmail_message_id, @amount, @merchant, @category, @card, @payment_method, @occurred_at, @currency, @source, @needs_review)
  `)
```

3d. En `insert(record)` (dentro de `forUser`), agregar el default:

```js
      insert(record) {
        const info = insertStmt.run({
          user_id: userId,
          card: null,
          payment_method: null,
          currency: 'ARS',
          source: 'santander',
          needs_review: 0,
          ...record,
        })
        return { inserted: info.changes > 0 }
      },
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/payment-method.test.js`
Expected: PASS (3 tests)

Después correr la suite entera para verificar que nada se rompió:

Run: `npm test`
Expected: PASS (todos los archivos)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/payment-method.test.js
git commit -m "feat(db): columna payment_method en expenses (Crédito/Débito, migración idempotente)"
```

---

### Task 2: La ingesta persiste el medio de pago

**Files:**
- Modify: `src/routes/ingest.js` (el `udb.insert({...})`, línea ~51)
- Modify: `test/payment-method.test.js` (agregar describe de ingesta)

**Interfaces:**
- Consumes: `udb.insert()` con `payment_method` (Task 1); `parseEmail()` ya devuelve `type: 'Crédito' | 'Débito' | null` (campo existente de `src/sources/santander.js`, fluye por el spread de `src/sources/index.js`).
- Produces: todo gasto ingresado por `POST /api/ingest` queda con `payment_method` = el `type` parseado del mail.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `test/payment-method.test.js`:

```js
import request from 'supertest'
import { createApp } from '../src/app.js'
import { TEST_CONFIG } from './helpers.js'

const MAIL_CREDITO = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Crédito terminada en 2044.

Monto
$50.000,00

Comercio
COTO SUC 99

Fecha
10/07/2026

Hora
12:00`

const MAIL_DEBITO = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/07/2026

Hora
19:12`

describe('ingesta: persiste el medio de pago', () => {
  let db, app, token, udb
  beforeEach(() => {
    db = createDb(':memory:')
    const user = db.createUser({ email: 'u@test.com', password: 'x' })
    app = createApp({ db, config: TEST_CONFIG })
    token = user.ingest_token
    udb = db.forUser(user.id)
  })

  const ingest = (messageId, body) =>
    request(app).post('/api/ingest').set('X-Webhook-Secret', token).send({ messageId, body })

  it('un consumo con crédito guarda payment_method = Crédito', async () => {
    const res = await ingest('m-cred', MAIL_CREDITO)
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(udb.list('2026-07').find((r) => r.gmail_message_id === 'm-cred').payment_method).toBe('Crédito')
  })

  it('un consumo con débito guarda payment_method = Débito', async () => {
    await ingest('m-deb', MAIL_DEBITO)
    expect(udb.list('2026-07').find((r) => r.gmail_message_id === 'm-deb').payment_method).toBe('Débito')
  })
})
```

(Los `import` van arriba del archivo junto a los existentes, no al final; vitest/ESM no permite imports después de código.)

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/payment-method.test.js`
Expected: FAIL — los dos tests nuevos dan `null` en vez de `'Crédito'`/`'Débito'` (la ingesta no pasa el campo).

- [ ] **Step 3: Implementar en `src/routes/ingest.js`**

En el `udb.insert({...})`, agregar `payment_method` después de `card`:

```js
    const { inserted } = udb.insert({
      gmail_message_id: messageId,
      amount: parsed.amount,
      merchant: parsed.merchant,
      category,
      card: parsed.card,
      payment_method: parsed.type || null,
      occurred_at,
      currency: parsed.currency,
      source: parsed.source,
      needs_review: needsReview,
    })
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/payment-method.test.js`
Expected: PASS (5 tests)

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/ingest.js test/payment-method.test.js
git commit -m "feat(ingest): persistir el medio de pago (parsed.type) en payment_method"
```

---

### Task 3: `totals` de la API excluye los gastos con crédito

**Files:**
- Modify: `src/routes/expenses.js` (loop de `totals` en el GET, línea ~17)
- Modify: `test/payment-method.test.js` (agregar describe de la ruta)

**Interfaces:**
- Consumes: filas de `udb.list(month)` con `payment_method` (Task 1).
- Produces: `GET /api/expenses` → `totals` sin los montos con `payment_method === 'Crédito'`; `expenses` sigue trayendo todas las filas (con `payment_method` incluido, porque el SELECT es `*`).

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `test/payment-method.test.js` (usa los helpers ya importados; `makeAppWithUser` y `authedAgent` hay que sumarlos al import de `./helpers.js`):

```js
import { makeUserDb, makeAppWithUser, authedAgent } from './helpers.js'
```

```js
describe('GET /api/expenses', () => {
  it('totals no incluye los gastos con crédito; expenses sí los trae', async () => {
    const { db, user, app } = makeAppWithUser()
    const udb = db.forUser(user.id)
    udb.insert(gasto({ amount: 1000, category: 'Comida', payment_method: 'Débito' }))
    udb.insert(gasto({ amount: 500, category: 'Comida', payment_method: 'Crédito' }))
    udb.insert(gasto({ amount: 200, category: 'Transporte' })) // NULL = débito, suma
    const agent = await authedAgent(app)
    const res = await agent.get('/api/expenses?month=2026-07')
    expect(res.body.totals).toEqual({ Comida: 1000, Transporte: 200 })
    expect(res.body.expenses).toHaveLength(3)
    expect(res.body.expenses.some((e) => e.payment_method === 'Crédito')).toBe(true)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/payment-method.test.js`
Expected: FAIL — `totals.Comida` da 1500 en vez de 1000.

- [ ] **Step 3: Implementar en `src/routes/expenses.js`**

En el loop de `totals` del GET, saltar también los crédito:

```js
    // Las categorías con excluded=1 y los consumos con crédito se ven en la
    // lista pero no suman al total (el crédito se debita el mes siguiente).
    const excluded = new Set(udb.listCategories().filter((c) => c.excluded).map((c) => c.name))
    const totals = {}
    for (const e of expenses) {
      if (excluded.has(e.category) || e.payment_method === 'Crédito') continue
      totals[e.category] = (totals[e.category] || 0) + e.amount
    }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/payment-method.test.js`
Expected: PASS (6 tests)

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/expenses.js test/payment-method.test.js
git commit -m "feat(api): totals de /api/expenses excluye consumos con crédito"
```

---

### Task 4: Frontend — línea "Tarjeta" en el header, exclusión del total/barra/leyenda, badge en el ledger

**Files:**
- Modify: `public/index.html` (header de totales, línea ~59)
- Modify: `public/app.js` (función `render()`, líneas ~70–148)
- Modify: `public/styles.css` (después de `.total-usd .cents`, línea ~242; y junto a `.row-card`, línea ~408)

Sin tests automatizados (el frontend vanilla no tiene infra de tests); la verificación es visual (Step 4).

**Interfaces:**
- Consumes: `expenses[].payment_method` del `GET /api/expenses` (Task 3).
- Produces: UI final del feature.

- [ ] **Step 1: Header en `public/index.html`**

Agregar la línea de tarjeta debajo de la de USD:

```html
        <h2 id="total" class="total">—</h2>
        <div id="total-usd" class="total-usd hidden"></div>
        <div id="total-tarjeta" class="total-tarjeta hidden"></div>
```

- [ ] **Step 2: Lógica en `public/app.js`**

2a. En `render()`, reemplazar el cálculo de totales (líneas ~70–87) por:

```js
function render({ expenses }) {
  // Pesos y dólares no se suman: el total grande es en pesos, el USD va aparte.
  // Las categorías excluidas (EXCLUDED) se ven en la lista pero no suman a nada.
  // Los consumos con crédito tampoco suman: se debitan el mes siguiente y van
  // en su propia línea ("Tarjeta"), como los USD.
  const noSuma = (e) => EXCLUDED.has(e.category)
  const esCredito = (e) => e.payment_method === 'Crédito'
  const ars = expenses.filter((e) => (e.currency || 'ARS') === 'ARS')
  const usd = expenses.filter((e) => e.currency === 'USD')
  const arsTotal = ars.filter((e) => !noSuma(e) && !esCredito(e)).reduce((s, e) => s + e.amount, 0)
  const usdTotal = usd.filter((e) => !noSuma(e)).reduce((s, e) => s + e.amount, 0)
  const tarjetaTotal = ars.filter((e) => !noSuma(e) && esCredito(e)).reduce((s, e) => s + e.amount, 0)

  $('#total').innerHTML = arsTotal ? money(arsTotal, 'ARS') : '<span class="muted">$0</span>'

  const usdEl = $('#total-usd')
  if (usdTotal > 0) {
    usdEl.innerHTML = money(usdTotal, 'USD')
    usdEl.classList.remove('hidden')
  } else {
    usdEl.classList.add('hidden')
  }

  const tarjetaEl = $('#total-tarjeta')
  if (tarjetaTotal > 0) {
    tarjetaEl.innerHTML = `Tarjeta: ${money(tarjetaTotal, 'ARS')}`
    tarjetaEl.classList.remove('hidden')
  } else {
    tarjetaEl.classList.add('hidden')
  }
```

2b. En el loop de la barra/leyenda (líneas ~91–95), excluir crédito:

```js
  const totals = {}
  for (const e of ars) {
    if (noSuma(e) || esCredito(e)) continue
    totals[e.category] = (totals[e.category] || 0) + e.amount
  }
```

2c. En el render del ledger (líneas ~134–147), badge y estilo atenuado:

```js
        .map((e, i) => {
          const { day, time } = fmtDate(e.occurred_at)
          const card = e.card ? `<span class="row-card">•${e.card}</span>` : ''
          const credito = esCredito(e) ? '<span class="row-credito">crédito</span>' : ''
          return `<div class="row${noSuma(e) || esCredito(e) ? ' excluded' : ''}" style="animation-delay:${Math.min(i * 22, 260)}ms">
            <div class="cell-date"><span class="d-day">${day}</span><span class="d-time">${time}</span></div>
            <div class="cell-merchant">
              <span class="row-merchant">${escape(e.merchant)}</span>${card}${credito}
            </div>
            <button class="cat" data-id="${e.id}" data-cat="${e.category}">
              <span class="dot" style="background:${colorOf(e.category)}"></span>${e.category}
            </button>
            <div class="row-amount${e.currency === 'USD' ? ' usd' : ''}${e.amount < 0 ? ' refund' : ''}">${money(e.amount, e.currency)}</div>
          </div>`
        })
```

- [ ] **Step 3: Estilos en `public/styles.css`**

3a. Después del bloque `.total-usd .cents` (línea ~242):

```css
/* acumulado del mes con tarjeta de crédito: no suma al total, se debita el mes
   que viene. Línea informativa aparte, como la de USD pero más discreta. */
.total-tarjeta {
  margin-top: 4px;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 20px;
  font-weight: 600;
  color: var(--ink-3);
  letter-spacing: -0.025em;
}
.total-tarjeta .cents {
  color: var(--ink-4);
}
```

3b. Después del bloque `.row-card` (línea ~413):

```css
/* badge "crédito" en el ledger: el consumo se ve pero no suma (mismo look que cat-nosum) */
.row-credito {
  font-size: 11px;
  color: var(--ink-3);
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
  flex: none;
}
```

- [ ] **Step 4: Verificación visual**

```bash
npm run dev
```

En `http://127.0.0.1:3000` (login con un usuario que tenga datos, o insertar a mano un gasto con crédito en el mes actual):

```bash
sqlite3 gastaker.db "UPDATE expenses SET payment_method = 'Crédito' WHERE id = (SELECT id FROM expenses WHERE user_id IS NOT NULL AND currency = 'ARS' ORDER BY occurred_at DESC LIMIT 1)"
```

Checklist visual:
- Aparece la línea `Tarjeta: $…` debajo del total (y de la línea USD si hay).
- El total grande NO incluye ese monto; la barra y la leyenda tampoco.
- El gasto se ve en el ledger atenuado y con el badge `crédito`.
- Un mes sin crédito no muestra la línea (navegar con el stepper a un mes viejo).

Revertir el dato de prueba si se usó una DB real:

```bash
sqlite3 gastaker.db "UPDATE expenses SET payment_method = NULL WHERE payment_method = 'Crédito' AND gmail_message_id NOT LIKE 'm-%'"
```

(Si el gasto tocado era genuinamente de crédito, dejarlo.)

- [ ] **Step 5: Correr la suite y commitear**

Run: `npm test`
Expected: PASS

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): acumulado Tarjeta aparte del total; crédito fuera de barra/leyenda con badge"
```
