# Gastaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una app personal que recibe los mails de gasto de Santander (vía un Google Apps Script que le pega a un webhook), los parsea, los categoriza por reglas, los guarda en SQLite sin duplicar, y los muestra en una web simple protegida por contraseña.

**Architecture:** Un solo proceso Node.js (Express) corriendo en un VPS. Un Google Apps Script en la cuenta del usuario hace de "poller": cada ~3 min busca mails de Santander y los POSTea al endpoint `/api/ingest`. El backend parsea/categoriza/guarda. El frontend (servido por el mismo Express) lista los gastos y permite recategorizar.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, cookie-parser. Tests con Vitest + Supertest. Frontend vanilla (HTML/CSS/JS). Ingesta vía Google Apps Script.

---

## File Structure

```
gastaker/
├── package.json
├── .gitignore
├── .env.example
├── src/
│   ├── parser.js          # texto del mail → {amount, merchant, occurredAt, card, type}
│   ├── categories.js      # tabla de reglas comercio→categoría
│   ├── categorizer.js     # categorize(merchant) → category
│   ├── db.js              # createDb(path) → {insert, list, updateCategory}
│   ├── auth.js            # requireAuth middleware + login handler
│   ├── app.js             # createApp({db, config}) → express app (sin listen)
│   ├── server.js          # carga env, crea db real, levanta el server
│   └── routes/
│       ├── ingest.js      # POST /api/ingest
│       └── expenses.js    # GET /api/expenses, PATCH /api/expenses/:id
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js             # frontend
├── apps-script/
│   └── Code.gs            # Google Apps Script (poller)
├── test/
│   ├── parser.test.js
│   ├── categorizer.test.js
│   ├── db.test.js
│   ├── ingest.test.js
│   └── expenses.test.js
└── README.md
```

**Responsabilidades:**
- `parser.js`, `categorizer.js`: lógica pura, sin red ni DB. Lo más testeable.
- `db.js`: único lugar que toca SQLite.
- `app.js`: arma el Express y monta las rutas; recibe `db` y `config` por parámetro para poder testear con una DB en memoria.
- `server.js`: el único archivo que lee variables de entorno y abre el puerto.

**Data shapes (consistentes en todo el plan):**
- `parser` devuelve: `{ amount: number, merchant: string, occurredAt: string (ISO), card: string|null, type: string|null }` o `null` si el mail no matchea.
- registro que guarda la DB: `{ gmail_message_id, amount, merchant, category, card, occurred_at }`
- columnas de la tabla `expenses`: `id, gmail_message_id, amount, merchant, category, card, occurred_at, created_at`
- `config`: `{ webhookSecret: string, appPassword: string, sessionToken: string }`

---

## Task 1: Scaffold del proyecto

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Inicializar git**

Run:
```bash
cd /Users/gastonfoncea/Desktop/026/developer/lab/gastaker
git init
```
Expected: `Initialized empty Git repository`

- [ ] **Step 2: Crear `package.json`**

```json
{
  "name": "gastaker",
  "version": "1.0.0",
  "description": "Tracker automatico de gastos desde Gmail (Santander)",
  "type": "module",
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "cookie-parser": "^1.4.7",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Crear `.gitignore`**

```
node_modules/
.env
*.db
*.db-journal
*.db-wal
*.db-shm
```

- [ ] **Step 4: Crear `.env.example`**

```
# Puerto donde escucha la app (interno; Caddy lo expone)
PORT=3000
# Ruta del archivo SQLite
DB_PATH=./gastaker.db
# Secreto que debe mandar el Apps Script en el header X-Webhook-Secret
WEBHOOK_SECRET=cambiame-por-algo-largo-y-aleatorio
# Contraseña para entrar a la web
APP_PASSWORD=cambiame-por-tu-clave
# Token de sesión (cualquier string largo aleatorio)
SESSION_TOKEN=cambiame-por-otro-string-aleatorio
```

- [ ] **Step 5: Instalar dependencias**

Run: `npm install`
Expected: crea `node_modules/` y `package-lock.json` sin errores.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example
git commit -m "chore: scaffold proyecto gastaker"
```

---

## Task 2: Parser de mails

**Files:**
- Create: `src/parser.js`
- Test: `test/parser.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/parser.test.js
import { describe, it, expect } from 'vitest'
import { parseExpenseEmail } from '../src/parser.js'

const SAMPLE = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/06/2026

Hora
19:12`

describe('parseExpenseEmail', () => {
  it('extrae monto, comercio, fecha/hora y tarjeta', () => {
    const r = parseExpenseEmail(SAMPLE)
    expect(r).not.toBeNull()
    expect(r.amount).toBe(12946.0)
    expect(r.merchant).toBe('VERDULERIA KATIE')
    expect(r.occurredAt).toBe('2026-06-08T19:12:00')
    expect(r.card).toBe('1458')
    expect(r.type).toBe('Débito')
  })

  it('parsea montos sin decimales y con miles', () => {
    const body = SAMPLE.replace('$12.946,00', '$1.500.000,50')
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(1500000.5)
  })

  it('detecta tarjeta de crédito', () => {
    const body = SAMPLE.replace('Visa Débito', 'Visa Crédito')
    const r = parseExpenseEmail(body)
    expect(r.type).toBe('Crédito')
  })

  it('devuelve null si falta el Monto o el Comercio', () => {
    expect(parseExpenseEmail('hola, esto no es un gasto')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- parser`
Expected: FAIL — `parseExpenseEmail is not a function` / no encuentra el módulo.

- [ ] **Step 3: Implementar `src/parser.js`**

```javascript
// src/parser.js

// Toma el texto plano de un mail de gasto de Santander y devuelve
// { amount, merchant, occurredAt, card, type } o null si no matchea.
export function parseExpenseEmail(text) {
  if (!text) return null

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const monto = valueAfterLabel(lines, 'Monto')
  const comercio = valueAfterLabel(lines, 'Comercio')
  const fecha = valueAfterLabel(lines, 'Fecha')
  const hora = valueAfterLabel(lines, 'Hora')

  if (!monto || !comercio) return null

  const amount = parseAmount(monto)
  if (amount === null) return null

  return {
    amount,
    merchant: comercio,
    occurredAt: toIso(fecha, hora),
    card: parseCard(text),
    type: parseType(text),
  }
}

// Busca una línea igual a `label` y devuelve la línea siguiente (el valor).
function valueAfterLabel(lines, label) {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase())
  if (i === -1 || i + 1 >= lines.length) return null
  return lines[i + 1]
}

// "$12.946,00" -> 12946.00 ; "$1.500.000,50" -> 1500000.50
function parseAmount(raw) {
  const cleaned = raw.replace(/[^\d.,]/g, '') // deja solo dígitos, . y ,
  if (!cleaned) return null
  const normalized = cleaned.replace(/\./g, '').replace(',', '.')
  const n = Number.parseFloat(normalized)
  return Number.isNaN(n) ? null : n
}

// "08/06/2026" + "19:12" -> "2026-06-08T19:12:00"
function toIso(fecha, hora) {
  if (!fecha) return null
  const m = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const time = (hora && /^\d{1,2}:\d{2}/.test(hora) ? hora : '00:00').padStart(5, '0')
  return `${yyyy}-${mm}-${dd}T${time}:00`
}

function parseCard(text) {
  const m = text.match(/terminada en (\d{4})/i)
  return m ? m[1] : null
}

function parseType(text) {
  if (/cr[eé]dito/i.test(text)) return 'Crédito'
  if (/d[eé]bito/i.test(text)) return 'Débito'
  return null
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- parser`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/parser.js test/parser.test.js
git commit -m "feat: parser de mails de gasto de Santander"
```

---

## Task 3: Categorizador por reglas

**Files:**
- Create: `src/categories.js`
- Create: `src/categorizer.js`
- Test: `test/categorizer.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/categorizer.test.js
import { describe, it, expect } from 'vitest'
import { categorize } from '../src/categorizer.js'

describe('categorize', () => {
  it('asigna categoría por coincidencia de substring', () => {
    expect(categorize('VERDULERIA KATIE')).toBe('Comida')
    expect(categorize('PEDIDOSYA')).toBe('Comida')
  })

  it('es case-insensitive', () => {
    expect(categorize('verduleria katie')).toBe('Comida')
  })

  it('devuelve Otros si no hay regla que matchee', () => {
    expect(categorize('COMERCIO RARO SA')).toBe('Otros')
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- categorizer`
Expected: FAIL — no encuentra `categorize`.

- [ ] **Step 3: Implementar `src/categories.js`**

```javascript
// src/categories.js
// Tabla de reglas: si el nombre del comercio CONTIENE `match` (case-insensitive),
// se le asigna `category`. Se evalúan en orden; la primera que matchea gana.
// Editá esta lista a gusto agregando tus comercios habituales.
export const RULES = [
  { match: 'VERDULERIA', category: 'Comida' },
  { match: 'PEDIDOSYA', category: 'Comida' },
  { match: 'RAPPI', category: 'Comida' },
  { match: 'CARREFOUR', category: 'Supermercado' },
  { match: 'COTO', category: 'Supermercado' },
  { match: 'DIA', category: 'Supermercado' },
  { match: 'YPF', category: 'Transporte' },
  { match: 'SHELL', category: 'Transporte' },
  { match: 'UBER', category: 'Transporte' },
  { match: 'SUBE', category: 'Transporte' },
  { match: 'NETFLIX', category: 'Suscripciones' },
  { match: 'SPOTIFY', category: 'Suscripciones' },
  { match: 'FARMACIA', category: 'Salud' },
  { match: 'EDENOR', category: 'Servicios' },
  { match: 'METROGAS', category: 'Servicios' },
]

export const DEFAULT_CATEGORY = 'Otros'
```

- [ ] **Step 4: Implementar `src/categorizer.js`**

```javascript
// src/categorizer.js
import { RULES, DEFAULT_CATEGORY } from './categories.js'

// Dado el nombre de un comercio, devuelve la categoría según las reglas.
export function categorize(merchant) {
  if (!merchant) return DEFAULT_CATEGORY
  const upper = merchant.toUpperCase()
  for (const rule of RULES) {
    if (upper.includes(rule.match.toUpperCase())) return rule.category
  }
  return DEFAULT_CATEGORY
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- categorizer`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/categories.js src/categorizer.js test/categorizer.test.js
git commit -m "feat: categorizador por reglas de comercio"
```

---

## Task 4: Capa de base de datos (SQLite)

**Files:**
- Create: `src/db.js`
- Test: `test/db.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/db.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db.js'

function sampleRecord(overrides = {}) {
  return {
    gmail_message_id: 'msg-1',
    amount: 12946.0,
    merchant: 'VERDULERIA KATIE',
    category: 'Comida',
    card: '1458',
    occurred_at: '2026-06-08T19:12:00',
    ...overrides,
  }
}

describe('db', () => {
  let db
  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('inserta un gasto y lo lista', () => {
    const res = db.insert(sampleRecord())
    expect(res.inserted).toBe(true)
    const rows = db.list('2026-06')
    expect(rows).toHaveLength(1)
    expect(rows[0].merchant).toBe('VERDULERIA KATIE')
    expect(rows[0].amount).toBe(12946.0)
  })

  it('no inserta dos veces el mismo gmail_message_id', () => {
    db.insert(sampleRecord())
    const res = db.insert(sampleRecord())
    expect(res.inserted).toBe(false)
    expect(db.list('2026-06')).toHaveLength(1)
  })

  it('filtra por mes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', occurred_at: '2026-06-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', occurred_at: '2026-07-01T10:00:00' }))
    expect(db.list('2026-06')).toHaveLength(1)
    expect(db.list('2026-07')).toHaveLength(1)
  })

  it('actualiza la categoría de un gasto', () => {
    db.insert(sampleRecord())
    const id = db.list('2026-06')[0].id
    const changed = db.updateCategory(id, 'Supermercado')
    expect(changed).toBe(true)
    expect(db.list('2026-06')[0].category).toBe('Supermercado')
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- db`
Expected: FAIL — no encuentra `createDb`.

- [ ] **Step 3: Implementar `src/db.js`**

```javascript
// src/db.js
import Database from 'better-sqlite3'

// createDb(path) inicializa el esquema y devuelve la API de la base.
// path puede ser ':memory:' (tests) o una ruta a archivo (producción).
export function createDb(path) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_message_id  TEXT    NOT NULL UNIQUE,
      amount            REAL    NOT NULL,
      merchant          TEXT    NOT NULL,
      category          TEXT    NOT NULL,
      card              TEXT,
      occurred_at       TEXT    NOT NULL,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (gmail_message_id, amount, merchant, category, card, occurred_at)
    VALUES
      (@gmail_message_id, @amount, @merchant, @category, @card, @occurred_at)
  `)

  const listStmt = sqlite.prepare(`
    SELECT * FROM expenses
    WHERE occurred_at LIKE @prefix
    ORDER BY occurred_at DESC
  `)

  const updateStmt = sqlite.prepare(`
    UPDATE expenses SET category = @category WHERE id = @id
  `)

  return {
    // Devuelve { inserted: boolean }. false si el gmail_message_id ya existía.
    insert(record) {
      const info = insertStmt.run({ card: null, ...record })
      return { inserted: info.changes > 0 }
    },
    // month: 'YYYY-MM'. Devuelve las filas de ese mes, más recientes primero.
    list(month) {
      return listStmt.all({ prefix: `${month}%` })
    },
    // Devuelve true si actualizó alguna fila.
    updateCategory(id, category) {
      return updateStmt.run({ id, category }).changes > 0
    },
    _raw: sqlite,
  }
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- db`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: capa SQLite con dedup por gmail_message_id"
```

---

## Task 5: App Express + ruta de ingesta (webhook)

**Files:**
- Create: `src/app.js`
- Create: `src/routes/ingest.js`
- Test: `test/ingest.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/ingest.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'

const CONFIG = {
  webhookSecret: 'secreto-test',
  appPassword: 'clave-test',
  sessionToken: 'token-test',
}

const SAMPLE = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/06/2026

Hora
19:12`

function makeApp() {
  return createApp({ db: createDb(':memory:'), config: CONFIG })
}

describe('POST /api/ingest', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('rechaza si falta o no coincide el secreto', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .set('X-Webhook-Secret', 'mal')
      .send({ messageId: 'm1', body: SAMPLE })
    expect(res.status).toBe(401)
  })

  it('parsea, categoriza y guarda un gasto válido', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .set('X-Webhook-Secret', 'secreto-test')
      .send({ messageId: 'm1', body: SAMPLE })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(res.body.category).toBe('Comida')
  })

  it('es idempotente con el mismo messageId', async () => {
    const send = () =>
      request(app)
        .post('/api/ingest')
        .set('X-Webhook-Secret', 'secreto-test')
        .send({ messageId: 'm1', body: SAMPLE })
    await send()
    const res = await send()
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(false)
  })

  it('responde skipped:true si el body no es un gasto', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .set('X-Webhook-Secret', 'secreto-test')
      .send({ messageId: 'm2', body: 'no soy un gasto' })
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe(true)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- ingest`
Expected: FAIL — no encuentra `createApp`.

- [ ] **Step 3: Implementar `src/routes/ingest.js`**

```javascript
// src/routes/ingest.js
import express from 'express'
import { parseExpenseEmail } from '../parser.js'
import { categorize } from '../categorizer.js'

// Crea el router de ingesta. Valida el secreto del webhook contra config.
export function ingestRouter({ db, config }) {
  const router = express.Router()

  router.post('/', (req, res) => {
    const secret = req.get('X-Webhook-Secret')
    if (!secret || secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'secreto inválido' })
    }

    const { messageId, body } = req.body || {}
    if (!messageId || !body) {
      return res.status(400).json({ error: 'faltan messageId o body' })
    }

    const parsed = parseExpenseEmail(body)
    if (!parsed) {
      return res.json({ skipped: true })
    }

    const category = categorize(parsed.merchant)
    const { inserted } = db.insert({
      gmail_message_id: messageId,
      amount: parsed.amount,
      merchant: parsed.merchant,
      category,
      card: parsed.card,
      occurred_at: parsed.occurredAt,
    })

    return res.json({ inserted, category })
  })

  return router
}
```

- [ ] **Step 4: Implementar `src/app.js`**

```javascript
// src/app.js
import express from 'express'
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ingestRouter } from './routes/ingest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// createApp({ db, config }) arma el Express y devuelve la app SIN levantarla.
// Se le inyecta db y config para poder testear con una DB en memoria.
export function createApp({ db, config }) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.use('/api/ingest', ingestRouter({ db, config }))

  // Sirve el frontend estático (HTML/CSS/JS no contienen datos sensibles).
  app.use(express.static(join(__dirname, '..', 'public')))

  return app
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- ingest`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app.js src/routes/ingest.js test/ingest.test.js
git commit -m "feat: app Express + webhook /api/ingest"
```

---

## Task 6: Autenticación (login + middleware)

**Files:**
- Create: `src/auth.js`
- Modify: `src/app.js` (montar login)

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/expenses.test.js  (parte de auth — el resto se completa en Task 7)
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'

const CONFIG = {
  webhookSecret: 'secreto-test',
  appPassword: 'clave-test',
  sessionToken: 'token-test',
}

function makeApp() {
  return createApp({ db: createDb(':memory:'), config: CONFIG })
}

describe('auth', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('login con clave correcta devuelve cookie', async () => {
    const res = await request(app).post('/api/login').send({ password: 'clave-test' })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie'].join()).toContain('gastaker_auth')
  })

  it('login con clave incorrecta da 401', async () => {
    const res = await request(app).post('/api/login').send({ password: 'mal' })
    expect(res.status).toBe(401)
  })

  it('GET /api/expenses sin cookie da 401', async () => {
    const res = await request(app).get('/api/expenses?month=2026-06')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- expenses`
Expected: FAIL — no existe `/api/login` (404, no 401/200).

- [ ] **Step 3: Implementar `src/auth.js`**

```javascript
// src/auth.js

// Handler de login: si la password coincide, setea una cookie httpOnly
// con el sessionToken. Montar en POST /api/login.
export function loginHandler({ config }) {
  return (req, res) => {
    const { password } = req.body || {}
    if (!password || password !== config.appPassword) {
      return res.status(401).json({ error: 'clave incorrecta' })
    }
    res.cookie('gastaker_auth', config.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    })
    return res.json({ ok: true })
  }
}

// Middleware que exige la cookie de sesión válida.
export function requireAuth({ config }) {
  return (req, res, next) => {
    if (req.cookies?.gastaker_auth === config.sessionToken) return next()
    return res.status(401).json({ error: 'no autorizado' })
  }
}
```

- [ ] **Step 4: Montar login en `src/app.js`**

En `src/app.js`, agregar el import arriba:

```javascript
import { loginHandler } from './auth.js'
```

Y montar la ruta justo después de `app.use('/api/ingest', ...)`:

```javascript
  app.post('/api/login', loginHandler({ config }))
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- expenses`
Expected: los 3 tests de `auth` pasan. (Los de `/api/expenses` que devuelven datos llegan en Task 7; por ahora el de "sin cookie da 401" pasa solo si la ruta existe — si da 404, se arregla en Task 7. Si querés, dejá ese test en `.skip` hasta Task 7.)

> Nota: el test "GET /api/expenses sin cookie da 401" requiere que la ruta exista y tenga el middleware. Se completa en Task 7; hasta entonces puede dar 404. No commitees con tests rojos: marcá ese único `it` como `it.skip` y quitá el skip en Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js src/app.js test/expenses.test.js
git commit -m "feat: login con contraseña y middleware de auth"
```

---

## Task 7: Rutas de gastos (listar + recategorizar)

**Files:**
- Create: `src/routes/expenses.js`
- Modify: `src/app.js` (montar router protegido)
- Modify: `test/expenses.test.js` (quitar el skip, agregar tests de datos)

- [ ] **Step 1: Completar el test (agregar al final de `test/expenses.test.js`)**

Quitar el `.skip` del test "GET /api/expenses sin cookie da 401" si lo pusiste, y agregar este bloque:

```javascript
async function authedAgent(app) {
  const agent = request.agent(app)
  await agent.post('/api/login').send({ password: 'clave-test' })
  return agent
}

const SAMPLE = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/06/2026

Hora
19:12`

async function seedExpense(app) {
  await request(app)
    .post('/api/ingest')
    .set('X-Webhook-Secret', 'secreto-test')
    .send({ messageId: 'm1', body: SAMPLE })
}

describe('GET /api/expenses', () => {
  it('lista los gastos del mes con totales por categoría', async () => {
    const app = makeApp()
    await seedExpense(app)
    const agent = await authedAgent(app)
    const res = await agent.get('/api/expenses?month=2026-06')
    expect(res.status).toBe(200)
    expect(res.body.expenses).toHaveLength(1)
    expect(res.body.totals).toEqual({ Comida: 12946.0 })
  })
})

describe('PATCH /api/expenses/:id', () => {
  it('cambia la categoría de un gasto', async () => {
    const app = makeApp()
    await seedExpense(app)
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const id = list.body.expenses[0].id
    const res = await agent.patch(`/api/expenses/${id}`).send({ category: 'Supermercado' })
    expect(res.status).toBe(200)
    const after = await agent.get('/api/expenses?month=2026-06')
    expect(after.body.expenses[0].category).toBe('Supermercado')
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- expenses`
Expected: FAIL — `/api/expenses` no existe (404).

- [ ] **Step 3: Implementar `src/routes/expenses.js`**

```javascript
// src/routes/expenses.js
import express from 'express'
import { requireAuth } from '../auth.js'

export function expensesRouter({ db, config }) {
  const router = express.Router()
  router.use(requireAuth({ config }))

  // GET /api/expenses?month=YYYY-MM  -> { expenses: [...], totals: {cat: monto} }
  router.get('/', (req, res) => {
    const month = req.query.month || defaultMonth()
    const expenses = db.list(month)
    const totals = {}
    for (const e of expenses) {
      totals[e.category] = (totals[e.category] || 0) + e.amount
    }
    res.json({ month, expenses, totals })
  })

  // PATCH /api/expenses/:id  { category }
  router.patch('/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10)
    const { category } = req.body || {}
    if (!category) return res.status(400).json({ error: 'falta category' })
    const ok = db.updateCategory(id, category)
    if (!ok) return res.status(404).json({ error: 'no encontrado' })
    res.json({ ok: true })
  })

  return router
}

function defaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
```

- [ ] **Step 4: Montar el router en `src/app.js`**

Agregar el import:

```javascript
import { expensesRouter } from './routes/expenses.js'
```

Y montarlo después del login (antes del `express.static`):

```javascript
  app.use('/api/expenses', expensesRouter({ db, config }))
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- expenses`
Expected: PASS (todos los tests de auth + expenses).

- [ ] **Step 6: Correr toda la suite**

Run: `npm test`
Expected: PASS — parser, categorizer, db, ingest, expenses, todo verde.

- [ ] **Step 7: Commit**

```bash
git add src/routes/expenses.js src/app.js test/expenses.test.js
git commit -m "feat: rutas GET/PATCH de gastos protegidas por auth"
```

---

## Task 8: Entry point del servidor

**Files:**
- Create: `src/server.js`

- [ ] **Step 1: Implementar `src/server.js`**

```javascript
// src/server.js
import { createApp } from './app.js'
import { createDb } from './db.js'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Falta la variable de entorno ${name}. Mirá .env.example`)
    process.exit(1)
  }
  return v
}

const config = {
  webhookSecret: requireEnv('WEBHOOK_SECRET'),
  appPassword: requireEnv('APP_PASSWORD'),
  sessionToken: requireEnv('SESSION_TOKEN'),
}

const dbPath = process.env.DB_PATH || './gastaker.db'
const port = Number.parseInt(process.env.PORT || '3000', 10)

const db = createDb(dbPath)
const app = createApp({ db, config })

// Escucha solo en localhost: queda invisible desde internet; Caddy le habla por dentro.
app.listen(port, '127.0.0.1', () => {
  console.log(`Gastaker escuchando en http://127.0.0.1:${port}`)
})
```

- [ ] **Step 2: Probar el arranque localmente**

Run:
```bash
WEBHOOK_SECRET=test APP_PASSWORD=test SESSION_TOKEN=test PORT=3000 node src/server.js
```
Expected: imprime `Gastaker escuchando en http://127.0.0.1:3000`. Cortá con Ctrl+C.

- [ ] **Step 3: Verificar el webhook a mano (smoke test)**

En otra terminal, con el server corriendo:
```bash
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H 'X-Webhook-Secret: test' -H 'Content-Type: application/json' \
  -d '{"messageId":"smoke-1","body":"Monto\n$1.000,00\nComercio\nKIOSCO TEST\nFecha\n08/06/2026\nHora\n10:00"}'
```
Expected: `{"inserted":true,"category":"Otros"}`. Cortá el server.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: entry point del server (localhost, lee env)"
```

---

## Task 9: Frontend

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`

- [ ] **Step 1: Crear `public/index.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gastaker</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <!-- Login -->
    <div id="login" class="card hidden">
      <h1>Gastaker</h1>
      <p>Ingresá tu contraseña</p>
      <form id="login-form">
        <input id="password" type="password" placeholder="Contraseña" autocomplete="current-password" />
        <button type="submit">Entrar</button>
      </form>
      <p id="login-error" class="error hidden">Clave incorrecta</p>
    </div>

    <!-- App -->
    <div id="app" class="hidden">
      <header>
        <h1>Gastaker</h1>
        <input id="month" type="month" />
      </header>
      <section id="totals" class="totals"></section>
      <section id="list" class="list"></section>
    </div>

    <script src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Crear `public/styles.css`**

```css
:root {
  --bg: #0f1115;
  --card: #181b22;
  --text: #e6e8ee;
  --muted: #9aa0ad;
  --accent: #6ea8fe;
  --border: #262a33;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
  max-width: 720px;
  margin-inline: auto;
}
.hidden { display: none !important; }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 360px;
  margin: 80px auto;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
h1 { font-size: 22px; margin: 0; }
input, button, select {
  font: inherit;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
}
button { background: var(--accent); color: #0b0d12; border: none; cursor: pointer; font-weight: 600; }
.error { color: #ff6b6b; }
.totals { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.chip {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 14px;
}
.chip strong { color: var(--accent); }
.list { display: flex; flex-direction: column; gap: 8px; }
.expense {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.expense .merchant { font-weight: 600; }
.expense .meta { color: var(--muted); font-size: 13px; }
.expense .amount { font-variant-numeric: tabular-nums; font-weight: 600; }
.expense select { font-size: 13px; padding: 4px 8px; }
.empty { color: var(--muted); text-align: center; padding: 40px; }
```

- [ ] **Step 3: Crear `public/app.js`**

```javascript
const CATEGORIES = [
  'Comida', 'Supermercado', 'Transporte', 'Servicios',
  'Suscripciones', 'Salud', 'Otros',
]

const $ = (sel) => document.querySelector(sel)

function fmt(n) {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2 })
}

function monthValue() {
  return $('#month').value || new Date().toISOString().slice(0, 7)
}

async function load() {
  const res = await fetch(`/api/expenses?month=${monthValue()}`)
  if (res.status === 401) {
    showLogin()
    return
  }
  const data = await res.json()
  showApp()
  renderTotals(data.totals)
  renderList(data.expenses)
}

function renderTotals(totals) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1])
  $('#totals').innerHTML = entries.length
    ? entries.map(([cat, sum]) => `<div class="chip">${cat} <strong>${fmt(sum)}</strong></div>`).join('')
    : ''
}

function renderList(expenses) {
  if (!expenses.length) {
    $('#list').innerHTML = '<div class="empty">Sin gastos este mes</div>'
    return
  }
  $('#list').innerHTML = expenses.map((e) => {
    const date = e.occurred_at.slice(0, 16).replace('T', ' ')
    const options = CATEGORIES
      .map((c) => `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`)
      .join('')
    return `
      <div class="expense">
        <div>
          <div class="merchant">${e.merchant}</div>
          <div class="meta">${date} · ${e.card ? '••' + e.card : ''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <select data-id="${e.id}">${options}</select>
          <div class="amount">${fmt(e.amount)}</div>
        </div>
      </div>`
  }).join('')

  document.querySelectorAll('.expense select').forEach((sel) => {
    sel.addEventListener('change', async (ev) => {
      await fetch(`/api/expenses/${ev.target.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: ev.target.value }),
      })
      load()
    })
  })
}

function showLogin() {
  $('#login').classList.remove('hidden')
  $('#app').classList.add('hidden')
}
function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#password').value }),
  })
  if (res.ok) {
    $('#login-error').classList.add('hidden')
    load()
  } else {
    $('#login-error').classList.remove('hidden')
  }
})

$('#month').addEventListener('change', load)
$('#month').value = new Date().toISOString().slice(0, 7)
load()
```

- [ ] **Step 4: Probar el frontend a mano**

Run el server (`WEBHOOK_SECRET=test APP_PASSWORD=test SESSION_TOKEN=test node src/server.js`), cargá un par de gastos con el `curl` del Task 8, abrí `http://127.0.0.1:3000` en el navegador, logueate con `test`, y verificá que ves los gastos, los totales, y que cambiar la categoría en el dropdown la persiste (recargá y sigue cambiada).
Expected: login funciona, lista y totales se ven, recategorizar persiste.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: frontend (login, lista, totales, recategorizar)"
```

---

## Task 10: Google Apps Script (poller)

**Files:**
- Create: `apps-script/Code.gs`

- [ ] **Step 1: Crear `apps-script/Code.gs`**

```javascript
// Gastaker — poller de Gmail.
// Pegá este archivo en https://script.google.com (proyecto nuevo),
// completá las 3 constantes, autorizalo, y poné un trigger de tiempo
// (cada 5 min) sobre la función sync.

const WEBHOOK_URL = 'https://TU-DOMINIO-O-IP/api/ingest' // ej: https://gastaker.tudominio.com/api/ingest
const WEBHOOK_SECRET = 'PEGA-ACA-EL-MISMO-WEBHOOK_SECRET-DEL-VPS'
const SENDER = 'mensajesyavisos@mails.santander.com.ar'
const LABEL_NAME = 'gastaker-procesado'

function sync() {
  const label = getOrCreateLabel(LABEL_NAME)
  // Mails del remitente que todavía no procesamos.
  const threads = GmailApp.search(`from:${SENDER} -label:${LABEL_NAME}`, 0, 50)

  threads.forEach((thread) => {
    let allOk = true
    thread.getMessages().forEach((msg) => {
      const payload = {
        messageId: msg.getId(),
        subject: msg.getSubject(),
        body: msg.getPlainBody(),
        receivedAt: msg.getDate().toISOString(),
      }
      const res = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      })
      if (res.getResponseCode() !== 200) allOk = false
    })
    // Solo etiquetamos como procesado si el VPS recibió todo OK.
    if (allOk) thread.addLabel(label)
  })
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name)
}
```

- [ ] **Step 2: Documentar el setup del Apps Script (se hace en `script.google.com`, no en código)**

Estos pasos los ejecuta el usuario manualmente (van también en el README, Task 11):
1. Ir a https://script.google.com → Nuevo proyecto.
2. Pegar el contenido de `apps-script/Code.gs`.
3. Completar `WEBHOOK_URL` (la URL pública del VPS) y `WEBHOOK_SECRET` (el mismo del `.env` del VPS).
4. Guardar. Ejecutar `sync` una vez a mano → Google pide autorización → aceptar (es a tu propia cuenta).
5. Reloj (Triggers) → Add Trigger → función `sync`, event source "Time-driven", "Minutes timer", "Every 5 minutes".

No hay test automatizado para esto (corre en infraestructura de Google). La verificación es el smoke test end-to-end del Task 11.

- [ ] **Step 3: Commit**

```bash
git add apps-script/Code.gs
git commit -m "feat: Google Apps Script poller de Gmail"
```

---

## Task 11: README y guía de deploy

**Files:**
- Create: `README.md`

- [ ] **Step 1: Crear `README.md`**

````markdown
# Gastaker

Tracker automático de gastos: lee los mails de Santander desde Gmail (vía Google
Apps Script) y los anota/categoriza en una web propia.

## Correr en local

```bash
cp .env.example .env   # editá los valores
npm install
npm test               # corre toda la suite
npm run dev            # levanta en http://127.0.0.1:3000
```

## Variables de entorno (.env)

| Var | Qué es |
|-----|--------|
| `PORT` | puerto interno (Caddy lo expone) |
| `DB_PATH` | ruta del archivo SQLite |
| `WEBHOOK_SECRET` | secreto que valida `/api/ingest` (igual en el Apps Script) |
| `APP_PASSWORD` | contraseña de la web |
| `SESSION_TOKEN` | string aleatorio para la cookie de sesión |

Generá secretos con: `openssl rand -hex 32`

## Deploy en el VPS

1. **Instalar Node** (una vez):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Traer el código y dependencias:**
   ```bash
   git clone <tu-repo> gastaker && cd gastaker
   npm install --omit=dev
   cp .env.example .env   # editá con secretos reales
   ```
3. **Dejar el proceso prendido con pm2:**
   ```bash
   sudo npm install -g pm2
   pm2 start src/server.js --name gastaker
   pm2 save
   pm2 startup   # seguí la instrucción que imprime (arranca al bootear)
   ```
4. **Firewall (UFW):**
   ```bash
   sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
   sudo ufw enable
   ```
   El puerto 3000 queda cerrado al público: la app escucha solo en localhost.
5. **Exponer con HTTPS (Caddy + dominio):**
   - Apuntá un (sub)dominio a la IP del VPS (registro A en tu proveedor de DNS).
   - Instalá Caddy: https://caddyserver.com/docs/install
   - `/etc/caddy/Caddyfile`:
     ```
     gastaker.tudominio.com {
         reverse_proxy localhost:3000
     }
     ```
   - `sudo systemctl reload caddy` → Caddy saca el certificado HTTPS solo.
   - (Alternativa sin dominio: `sudo ufw allow 3000` y entrá por `http://IP:3000`,
     pero sin HTTPS. Solo para probar.)

## Apps Script (lado Gmail)

Ver `apps-script/Code.gs` y seguir los pasos de su encabezado:
pegar en script.google.com, completar `WEBHOOK_URL` y `WEBHOOK_SECRET`,
autorizar, y poner un trigger de tiempo cada 5 min sobre `sync`.

## Deploys siguientes

```bash
git pull && npm install --omit=dev && pm2 restart gastaker
```

## Agregar reglas de categorías

Editá `src/categories.js` (lista `RULES`) y reiniciá el proceso.
````

- [ ] **Step 2: Smoke test end-to-end (manual, una vez desplegado)**

1. Con el VPS corriendo y el Apps Script configurado, ejecutá `sync` a mano en Apps Script.
2. Hacé una compra chica real (o esperá la próxima) → llega el mail.
3. En ≤5 min, abrí la web → el gasto aparece anotado y categorizado.
4. Verificá en Gmail que el mail quedó con la etiqueta `gastaker-procesado`.

Expected: el gasto aparece una sola vez, con monto/comercio/fecha correctos.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README con guía de deploy y smoke test"
```

---

## Notas de cierre

- **Pendiente menor (no bloquea):** el asunto exacto del mail no se usa en el filtro
  (se filtra por remitente + estructura del cuerpo). Si más adelante querés afinar,
  se agrega al query del Apps Script.
- **Reglas de categorías:** la lista inicial en `src/categories.js` es un punto de
  partida; el usuario la va completando con sus comercios reales.
- **Upgrade futuro:** login con Google (cuando haya dominio), o IA de respaldo para
  categorizar comercios desconocidos. Ambos quedan fuera de este plan (YAGNI).
