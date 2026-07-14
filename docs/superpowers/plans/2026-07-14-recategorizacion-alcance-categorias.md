# Recategorización con alcance + categorías dinámicas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al recategorizar un gasto en la web, poder elegir "solo este gasto" o "siempre este comercio" (aprende la regla y pisa el histórico), y poder crear/renombrar/borrar categorías desde una página nueva accesible por menú hamburguesa.

**Architecture:** Backend Express con `createApp({ db, config })` inyectable; toda la lógica de datos vive en `src/db.js` (better-sqlite3, API de métodos). Frontend vanilla en `public/` (sin framework, sin build). Se agrega una tabla `categories`, un router nuevo `/api/categories`, se extiende `PATCH /api/expenses/:id` con flag `learn`, y se agregan una página `categorias.html` y un segundo paso al popover de recategorización.

**Tech Stack:** Node ESM, Express 4, better-sqlite3, vitest + supertest (tests), HTML/CSS/JS vanilla.

**Spec:** `docs/superpowers/specs/2026-07-14-recategorizacion-alcance-categorias-design.md`

## Global Constraints

- Todo el código y comentarios en español, siguiendo el estilo existente (comentarios breves que explican el porqué).
- `Otros` es la categoría protegida: no se renombra ni se borra (es `DEFAULT_CATEGORY` en `src/categories.js`).
- Los tests corren con `npx vitest run` (o `npm test`). No agregar dependencias nuevas.
- Las rutas de API van detrás de `requireAuth({ config })` igual que `expensesRouter`.
- Commits frecuentes con mensajes `feat:`/`test:`/`fix:` en español, como el historial existente.

---

### Task 1: `registrarComercio` pisa el histórico (no solo pendientes)

**Files:**
- Modify: `src/db.js:151-165` (método `registrarComercio`)
- Modify: `test/db.test.js:111-118` (test existente que cambia de semántica)
- Modify: `test/agent/tools.test.js:33-36` (nombre del test, referencia al campo viejo)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `db.registrarComercio({ match, categoria, alias? })` ahora devuelve `{ inserted: true, actualizados: <number> }` y actualiza TODOS los gastos cuyo merchant contenga `match` (case-insensitive), no solo los `needs_review = 1`. Task 2 depende del campo `actualizados`.

- [ ] **Step 1: Actualizar el test existente y agregar el caso de histórico**

En `test/db.test.js`, reemplazar el test `'registrarComercio guarda la regla y clasifica los pendientes que matchean'` (líneas 111-118) por estos dos:

```js
  it('registrarComercio guarda la regla y re-clasifica los que matchean', () => {
    db.insert(sampleRecord({ gmail_message_id: 't', merchant: 'Transferencia · 999', category: 'Transferencias', needs_review: 1 }))
    const r = db.registrarComercio({ match: '999', categoria: 'Vivienda', alias: 'Alquiler' })
    expect(r.inserted).toBe(true)
    expect(r.actualizados).toBe(1)
    expect(db.list('2026-06')[0].category).toBe('Vivienda')
    expect(db.list('2026-06')[0].needs_review).toBe(0)
  })

  it('registrarComercio pisa también el histórico ya categorizado', () => {
    // Un gasto viejo, ya categorizado (needs_review = 0), del mismo comercio.
    db.insert(sampleRecord({ gmail_message_id: 'viejo', merchant: 'PAYU*AR*UBER', category: 'Otros', needs_review: 0 }))
    db.insert(sampleRecord({ gmail_message_id: 'pend', merchant: 'PAYU*AR*UBER', category: 'Otros', needs_review: 1 }))
    const r = db.registrarComercio({ match: 'PAYU*AR*UBER', categoria: 'Transporte' })
    expect(r.actualizados).toBe(2)
    for (const row of db.list('2026-06')) {
      expect(row.category).toBe('Transporte')
      expect(row.needs_review).toBe(0)
    }
  })
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/db.test.js`
Expected: FAIL — `r.actualizados` es `undefined` y el gasto histórico sigue en `Otros`.

- [ ] **Step 3: Cambiar `registrarComercio` en `src/db.js`**

Reemplazar el método (líneas 151-165) por:

```js
    // Registra un comercio/CUIT aprendido y re-clasifica TODOS los gastos que
    // matcheen (histórico incluido): "registrar" significa que ese comercio ES
    // esa categoría, siempre.
    registrarComercio({ match, categoria, alias = null }) {
      const m = (match || '').trim()
      const BLACKLIST = ['transferencia', 'pago', 'compra', 'consumo', 'debito', 'credito']
      if (m.length < 3 || BLACKLIST.includes(m.toLowerCase())) {
        throw new Error('match inválido: debe ser un identificador específico (no genérico ni < 4 caracteres)')
      }
      sqlite
        .prepare('INSERT OR REPLACE INTO comercios_conocidos (match, category, alias) VALUES (@m, @categoria, @alias)')
        .run({ m, categoria, alias })
      const upd = sqlite
        .prepare("UPDATE expenses SET category = @categoria, needs_review = 0 WHERE upper(merchant) LIKE '%' || upper(@m) || '%'")
        .run({ m, categoria })
      return { inserted: true, actualizados: upd.changes }
    },
```

(El único cambio real es sacar `needs_review = 1 AND` del WHERE y renombrar el campo devuelto.)

- [ ] **Step 4: Renombrar la referencia en el test del agente**

En `test/agent/tools.test.js` (línea 33), el test solo chequea `r.inserted`, pero el nombre menciona el campo viejo. Cambiar el título:

```js
  it('execute(registrar_comercio) guarda la regla y devuelve actualizados', async () => {
    const r = await tools.execute('registrar_comercio', { match: 'NETFLIX', categoria: 'Suscripciones' })
    expect(r.inserted).toBe(true)
  })
```

- [ ] **Step 5: Correr TODA la suite y verificar que pasa**

Run: `npx vitest run`
Expected: PASS completo (los tests de ingest usan `registrarComercio` solo para sembrar reglas; no les afecta).

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db.test.js test/agent/tools.test.js
git commit -m "feat: registrarComercio pisa el histórico completo del comercio"
```

---

### Task 2: `PATCH /api/expenses/:id` con `learn` (y adiós `updateCategory`)

**Files:**
- Modify: `src/routes/expenses.js:21-29` (handler del PATCH)
- Modify: `src/db.js` (agregar `getExpense`, eliminar `updateCategory` y su statement)
- Modify: `test/db.test.js:46-53` (migrar el test de `updateCategory` a `clasificarGasto`)
- Modify: `test/expenses.test.js` (ampliar tests del PATCH)

**Interfaces:**
- Consumes: `db.clasificarGasto(id, categoria)` (existente), `db.registrarComercio(...)` → `{ actualizados }` (Task 1).
- Produces: `PATCH /api/expenses/:id` con body `{ category, learn?: boolean }` → `200 { ok: true, actualizados: <number> }` | `400` (falta category, o merchant no registrable) | `404`. Nuevo método `db.getExpense(id)` → fila completa o `undefined`. Task 5 (frontend) consume este contrato.

- [ ] **Step 1: Escribir los tests del endpoint**

En `test/expenses.test.js`, reemplazar el bloque `describe('PATCH /api/expenses/:id', ...)` por:

```js
describe('PATCH /api/expenses/:id', () => {
  it('cambia la categoría de un gasto y limpia needs_review', async () => {
    const app = makeApp()
    await seedExpense(app)
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const id = list.body.expenses[0].id
    const res = await agent.patch(`/api/expenses/${id}`).send({ category: 'Supermercado' })
    expect(res.status).toBe(200)
    const after = await agent.get('/api/expenses?month=2026-06')
    expect(after.body.expenses[0].category).toBe('Supermercado')
    expect(after.body.expenses[0].needs_review).toBe(0)
  })

  it('sin learn NO toca otros gastos del mismo comercio', async () => {
    const db = createDb(':memory:')
    const app = createApp({ db, config: CONFIG })
    db.insert({ gmail_message_id: 'a', amount: 100, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    db.insert({ gmail_message_id: 'b', amount: 200, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-02T10:00:00' })
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const [first, second] = list.body.expenses // orden: más reciente primero
    await agent.patch(`/api/expenses/${first.id}`).send({ category: 'Transporte' })
    const after = await agent.get('/api/expenses?month=2026-06')
    const otro = after.body.expenses.find((e) => e.id === second.id)
    expect(otro.category).toBe('Otros')
  })

  it('con learn aprende la regla y pisa todos los gastos del comercio', async () => {
    const db = createDb(':memory:')
    const app = createApp({ db, config: CONFIG })
    db.insert({ gmail_message_id: 'a', amount: 100, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    db.insert({ gmail_message_id: 'b', amount: 200, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-02T10:00:00', needs_review: 1 })
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const id = list.body.expenses[0].id
    const res = await agent.patch(`/api/expenses/${id}`).send({ category: 'Transporte', learn: true })
    expect(res.status).toBe(200)
    expect(res.body.actualizados).toBe(2)
    const after = await agent.get('/api/expenses?month=2026-06')
    for (const e of after.body.expenses) {
      expect(e.category).toBe('Transporte')
      expect(e.needs_review).toBe(0)
    }
    // La regla quedó aprendida.
    expect(db.findLearned('PAYU*AR*UBER')).toBe('Transporte')
  })

  it('con learn y un merchant no registrable (genérico) devuelve 400', async () => {
    const db = createDb(':memory:')
    const app = createApp({ db, config: CONFIG })
    // "Transferencia" pelado está en la blacklist de registrarComercio.
    db.insert({ gmail_message_id: 'a', amount: 100, merchant: 'Transferencia', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const id = list.body.expenses[0].id
    const res = await agent.patch(`/api/expenses/${id}`).send({ category: 'Comida', learn: true })
    expect(res.status).toBe(400)
    // El gasto individual tampoco se tocó (la operación es atómica de cara al usuario).
    const after = await agent.get('/api/expenses?month=2026-06')
    expect(after.body.expenses[0].category).toBe('Otros')
  })

  it('gasto inexistente devuelve 404', async () => {
    const app = makeApp()
    const agent = await authedAgent(app)
    const res = await agent.patch('/api/expenses/9999').send({ category: 'Comida' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/expenses.test.js`
Expected: FAIL — `actualizados` undefined, el 400 del merchant genérico hoy es 500/200, y needs_review no se limpia.

- [ ] **Step 3: Agregar `getExpense` a `src/db.js` y eliminar `updateCategory`**

En `src/db.js`: borrar `updateStmt` (líneas 61-63) y el método `updateCategory` (líneas 75-78). Agregar junto a los otros métodos:

```js
    // Fila completa de un gasto por id, o undefined si no existe.
    getExpense(id) {
      return sqlite.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
    },
```

- [ ] **Step 4: Reescribir el handler del PATCH en `src/routes/expenses.js`**

Reemplazar el handler (líneas 21-29) por:

```js
  // PATCH /api/expenses/:id  { category, learn? }
  // learn: además de clasificar este gasto, aprende "merchant -> category"
  // y re-clasifica todos los gastos de ese comercio (histórico incluido).
  router.patch('/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10)
    const { category, learn } = req.body || {}
    if (!category) return res.status(400).json({ error: 'falta category' })
    const expense = db.getExpense(id)
    if (!expense) return res.status(404).json({ error: 'no encontrado' })

    if (learn) {
      // registrarComercio valida el match (blacklist / largo mínimo) y ya
      // re-clasifica este mismo gasto, porque su merchant se contiene a sí mismo.
      try {
        const r = db.registrarComercio({ match: expense.merchant, categoria: category })
        return res.json({ ok: true, actualizados: r.actualizados })
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
    }

    db.clasificarGasto(id, category)
    res.json({ ok: true, actualizados: 1 })
  })
```

- [ ] **Step 5: Migrar el test de `updateCategory` en `test/db.test.js`**

Reemplazar el test `'actualiza la categoría de un gasto'` (líneas 46-53) por:

```js
  it('clasificarGasto actualiza la categoría de un gasto', () => {
    db.insert(sampleRecord())
    const id = db.list('2026-06')[0].id
    const changed = db.clasificarGasto(id, 'Supermercado')
    expect(changed).toBe(true)
    expect(db.list('2026-06')[0].category).toBe('Supermercado')
  })
```

- [ ] **Step 6: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS completo. Si algo más usaba `updateCategory`, va a explotar acá — migrarlo a `clasificarGasto`.

- [ ] **Step 7: Commit**

```bash
git add src/db.js src/routes/expenses.js test/db.test.js test/expenses.test.js
git commit -m "feat: PATCH /api/expenses acepta learn (aprende el comercio y pisa histórico)"
```

---

### Task 3: Tabla `categories` + métodos CRUD en la DB

**Files:**
- Modify: `src/db.js` (schema + seed + 4 métodos nuevos)
- Modify: `test/db.test.js` (describe nuevo)

**Interfaces:**
- Consumes: nada nuevo.
- Produces (Task 4 los consume tal cual):
  - `db.listCategories()` → `[{ id, name, color, count }]` (count = gastos con esa categoría).
  - `db.createCategory({ name, color })` → `{ id, name, color }`. Throws `Error` con `e.code`: `'VALIDATION'` (nombre vacío / color no `#RRGGBB`) o `'DUP'` (nombre repetido, case-insensitive).
  - `db.updateCategoryDef(id, { name?, color? })` → `{ id, name, color }`. Throws `e.code`: `'NOT_FOUND'`, `'PROTECTED'` (renombrar Otros), `'DUP'`, `'VALIDATION'`. Renombrar cascadea a `expenses` y `comercios_conocidos` en una transacción. Cambiar solo el color de Otros SÍ está permitido.
  - `db.deleteCategory(id)` → `{ movidos }` (gastos que pasaron a Otros). Throws `e.code`: `'NOT_FOUND'`, `'PROTECTED'` (Otros). Borra también las reglas de `comercios_conocidos` de esa categoría, en una transacción.

- [ ] **Step 1: Escribir los tests**

Agregar al final de `test/db.test.js`, dentro del `describe('db', ...)` (usa el `db` del `beforeEach`):

```js
  // Devuelve el e.code del error que lanza fn, o null si no lanzó.
  const codeOf = (fn) => {
    try {
      fn()
      return null
    } catch (e) {
      return e.code
    }
  }

  describe('categorías', () => {
    it('seedea las 8 categorías iniciales con color', () => {
      const cats = db.listCategories()
      expect(cats.map((c) => c.name)).toEqual([
        'Comida', 'Supermercado', 'Transporte', 'Servicios',
        'Suscripciones', 'Salud', 'Transferencias', 'Otros',
      ])
      expect(cats[0].color).toBe('#FF6B35')
      expect(cats[0].count).toBe(0)
    })

    it('listCategories cuenta los gastos de cada categoría', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // Comida
      db.insert(sampleRecord({ gmail_message_id: 'b' })) // Comida
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      expect(comida.count).toBe(2)
    })

    it('createCategory crea con nombre y color válidos', () => {
      const c = db.createCategory({ name: 'Ropa', color: '#EF4444' })
      expect(c.id).toBeTruthy()
      expect(db.listCategories().some((x) => x.name === 'Ropa')).toBe(true)
    })

    it('createCategory rechaza duplicados (case-insensitive) con code DUP', () => {
      expect(codeOf(() => db.createCategory({ name: 'comida', color: '#EF4444' }))).toBe('DUP')
    })

    it('createCategory valida nombre y color con code VALIDATION', () => {
      expect(codeOf(() => db.createCategory({ name: '  ', color: '#EF4444' }))).toBe('VALIDATION')
      expect(codeOf(() => db.createCategory({ name: 'Ropa', color: 'rojo' }))).toBe('VALIDATION')
    })

    it('updateCategoryDef renombra y cascadea a expenses y comercios_conocidos', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // category: Comida
      db.registrarComercio({ match: 'VERDULERIA', categoria: 'Comida' })
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      db.updateCategoryDef(comida.id, { name: 'Morfi' })
      expect(db.list('2026-06')[0].category).toBe('Morfi')
      expect(db.findLearned('VERDULERIA KATIE')).toBe('Morfi')
      expect(db.listCategories().some((c) => c.name === 'Morfi')).toBe(true)
    })

    it('updateCategoryDef no renombra Otros pero sí le cambia el color', () => {
      const otros = db.listCategories().find((c) => c.name === 'Otros')
      expect(codeOf(() => db.updateCategoryDef(otros.id, { name: 'Misc' }))).toBe('PROTECTED')
      const r = db.updateCategoryDef(otros.id, { color: '#111111' })
      expect(r.color).toBe('#111111')
    })

    it('deleteCategory mueve los gastos a Otros y borra las reglas', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // Comida
      db.registrarComercio({ match: 'VERDULERIA', categoria: 'Comida' })
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      const r = db.deleteCategory(comida.id)
      expect(r.movidos).toBe(1)
      expect(db.list('2026-06')[0].category).toBe('Otros')
      expect(db.findLearned('VERDULERIA KATIE')).toBe(null)
      expect(db.listCategories().some((c) => c.name === 'Comida')).toBe(false)
    })

    it('deleteCategory rechaza Otros e inexistentes', () => {
      const otros = db.listCategories().find((c) => c.name === 'Otros')
      expect(codeOf(() => db.deleteCategory(otros.id))).toBe('PROTECTED')
      expect(codeOf(() => db.deleteCategory(9999))).toBe('NOT_FOUND')
    })
  })
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run test/db.test.js`
Expected: FAIL — `db.listCategories is not a function`.

- [ ] **Step 3: Schema + seed en `src/db.js`**

Después del bloque `CREATE TABLE IF NOT EXISTS comercios_conocidos` (línea ~46), agregar:

```js
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Seed idempotente: solo si la tabla está vacía (bases nuevas o migradas).
  // Nombres y colores espejan el CATS histórico del frontend.
  if (sqlite.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const seed = sqlite.prepare('INSERT INTO categories (name, color) VALUES (?, ?)')
    for (const [name, color] of [
      ['Comida', '#FF6B35'],
      ['Supermercado', '#06B6D4'],
      ['Transporte', '#4F46E5'],
      ['Servicios', '#A855F7'],
      ['Suscripciones', '#EC4899'],
      ['Salud', '#10B981'],
      ['Transferencias', '#F59E0B'],
      ['Otros', '#64748B'],
    ]) {
      seed.run(name, color)
    }
  }
```

- [ ] **Step 4: Métodos CRUD en el objeto devuelto por `createDb`**

Agregar un helper arriba del `return` y los métodos dentro del objeto:

```js
  // Error con código, para que las rutas mapeen a status HTTP sin parsear mensajes.
  const fail = (code, message) => {
    const e = new Error(message)
    e.code = code
    throw e
  }
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/
```

```js
    listCategories() {
      return sqlite
        .prepare(`
          SELECT c.id, c.name, c.color,
                 (SELECT COUNT(*) FROM expenses e WHERE e.category = c.name) AS count
          FROM categories c ORDER BY c.id
        `)
        .all()
    },

    createCategory({ name, color }) {
      const n = (name || '').trim()
      if (!n) fail('VALIDATION', 'falta el nombre')
      if (!COLOR_RE.test(color || '')) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
      if (sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(n)) {
        fail('DUP', `ya existe la categoría "${n}"`)
      }
      const info = sqlite.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(n, color)
      return { id: info.lastInsertRowid, name: n, color }
    },

    // Renombrar cascadea por nombre a expenses y comercios_conocidos.
    // "Otros" no se renombra (es el fallback del categorizador y del delete).
    updateCategoryDef(id, { name, color } = {}) {
      const row = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id)
      if (!row) fail('NOT_FOUND', 'categoría no encontrada')
      const newName = name === undefined ? row.name : (name || '').trim()
      const newColor = color === undefined ? row.color : color
      if (!newName) fail('VALIDATION', 'falta el nombre')
      if (!COLOR_RE.test(newColor)) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
      if (row.name === 'Otros' && newName !== 'Otros') fail('PROTECTED', '"Otros" no se puede renombrar')
      if (
        newName.toLowerCase() !== row.name.toLowerCase() &&
        sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(newName)
      ) {
        fail('DUP', `ya existe la categoría "${newName}"`)
      }
      sqlite.transaction(() => {
        if (newName !== row.name) {
          sqlite.prepare('UPDATE expenses SET category = ? WHERE category = ?').run(newName, row.name)
          sqlite.prepare('UPDATE comercios_conocidos SET category = ? WHERE category = ?').run(newName, row.name)
        }
        sqlite.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(newName, newColor, id)
      })()
      return { id, name: newName, color: newColor }
    },

    // Borra la categoría: sus gastos pasan a "Otros" y sus reglas aprendidas se van.
    deleteCategory(id) {
      const row = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id)
      if (!row) fail('NOT_FOUND', 'categoría no encontrada')
      if (row.name === 'Otros') fail('PROTECTED', '"Otros" no se puede borrar')
      let movidos = 0
      sqlite.transaction(() => {
        movidos = sqlite.prepare("UPDATE expenses SET category = 'Otros' WHERE category = ?").run(row.name).changes
        sqlite.prepare('DELETE FROM comercios_conocidos WHERE category = ?').run(row.name)
        sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id)
      })()
      return { movidos }
    },
```

- [ ] **Step 5: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS completo.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: tabla categories con seed y CRUD (rename cascadea, delete mueve a Otros)"
```

---

### Task 4: Router `/api/categories`

**Files:**
- Create: `src/routes/categories.js`
- Modify: `src/app.js` (montar el router)
- Create: `test/routes/categories.test.js`

**Interfaces:**
- Consumes: `db.listCategories/createCategory/updateCategoryDef/deleteCategory` (Task 3), `requireAuth({ config })` de `src/auth.js`.
- Produces (Task 5 y 6 consumen esto):
  - `GET /api/categories` → `200 { categories: [{ id, name, color, count }] }`
  - `POST /api/categories { name, color }` → `201 { id, name, color }` | `400` | `409`
  - `PATCH /api/categories/:id { name?, color? }` → `200 { id, name, color }` | `400` | `404` | `409`
  - `DELETE /api/categories/:id` → `200 { ok: true, movidos }` | `400` | `404`
  - Todo detrás de auth por cookie (401 sin sesión).

- [ ] **Step 1: Escribir los tests**

Crear `test/routes/categories.test.js`:

```js
// test/routes/categories.test.js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import { createDb } from '../../src/db.js'

const CONFIG = {
  webhookSecret: 'secreto-test',
  appPassword: 'clave-test',
  sessionToken: 'token-test',
}

function makeApp() {
  const db = createDb(':memory:')
  return { db, app: createApp({ db, config: CONFIG }) }
}

async function authedAgent(app) {
  const agent = request.agent(app)
  await agent.post('/api/login').send({ password: 'clave-test' })
  return agent
}

describe('/api/categories', () => {
  it('sin cookie devuelve 401', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/categories')).status).toBe(401)
  })

  it('GET lista las categorías seed con count', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const res = await agent.get('/api/categories')
    expect(res.status).toBe(200)
    expect(res.body.categories).toHaveLength(8)
    expect(res.body.categories[0]).toMatchObject({ name: 'Comida', color: '#FF6B35', count: 0 })
  })

  it('POST crea una categoría', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const res = await agent.post('/api/categories').send({ name: 'Ropa', color: '#EF4444' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Ropa', color: '#EF4444' })
  })

  it('POST duplicado da 409, inválido da 400', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    expect((await agent.post('/api/categories').send({ name: 'comida', color: '#EF4444' })).status).toBe(409)
    expect((await agent.post('/api/categories').send({ name: '', color: '#EF4444' })).status).toBe(400)
    expect((await agent.post('/api/categories').send({ name: 'Ropa', color: 'rojo' })).status).toBe(400)
  })

  it('PATCH renombra (cascadea) y DELETE mueve a Otros', async () => {
    const { db, app } = makeApp()
    db.insert({ gmail_message_id: 'a', amount: 100, merchant: 'VERDULERIA KATIE', category: 'Comida', occurred_at: '2026-06-01T10:00:00' })
    const agent = await authedAgent(app)
    const comida = (await agent.get('/api/categories')).body.categories.find((c) => c.name === 'Comida')

    const ren = await agent.patch(`/api/categories/${comida.id}`).send({ name: 'Morfi' })
    expect(ren.status).toBe(200)
    expect(db.list('2026-06')[0].category).toBe('Morfi')

    const del = await agent.delete(`/api/categories/${comida.id}`)
    expect(del.status).toBe(200)
    expect(del.body.movidos).toBe(1)
    expect(db.list('2026-06')[0].category).toBe('Otros')
  })

  it('Otros está protegida: PATCH de nombre y DELETE dan 400', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const otros = (await agent.get('/api/categories')).body.categories.find((c) => c.name === 'Otros')
    expect((await agent.patch(`/api/categories/${otros.id}`).send({ name: 'Misc' })).status).toBe(400)
    expect((await agent.delete(`/api/categories/${otros.id}`)).status).toBe(400)
  })

  it('id inexistente da 404', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    expect((await agent.patch('/api/categories/9999').send({ name: 'X' })).status).toBe(404)
    expect((await agent.delete('/api/categories/9999')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run test/routes/categories.test.js`
Expected: FAIL — 404 en todas las rutas (el router no existe).

- [ ] **Step 3: Crear `src/routes/categories.js`**

```js
// src/routes/categories.js
import express from 'express'
import { requireAuth } from '../auth.js'

// Mapea los códigos de error de la db a status HTTP.
const STATUS = { VALIDATION: 400, PROTECTED: 400, NOT_FOUND: 404, DUP: 409 }
const fail = (res, e) => res.status(STATUS[e.code] || 500).json({ error: e.message })

export function categoriesRouter({ db, config }) {
  const router = express.Router()
  router.use(requireAuth({ config }))

  // GET /api/categories -> { categories: [{ id, name, color, count }] }
  router.get('/', (req, res) => {
    res.json({ categories: db.listCategories() })
  })

  // POST /api/categories { name, color }
  router.post('/', (req, res) => {
    try {
      res.status(201).json(db.createCategory(req.body || {}))
    } catch (e) {
      fail(res, e)
    }
  })

  // PATCH /api/categories/:id { name?, color? }
  router.patch('/:id', (req, res) => {
    try {
      res.json(db.updateCategoryDef(Number.parseInt(req.params.id, 10), req.body || {}))
    } catch (e) {
      fail(res, e)
    }
  })

  // DELETE /api/categories/:id -> los gastos pasan a "Otros"
  router.delete('/:id', (req, res) => {
    try {
      const r = db.deleteCategory(Number.parseInt(req.params.id, 10))
      res.json({ ok: true, movidos: r.movidos })
    } catch (e) {
      fail(res, e)
    }
  })

  return router
}
```

- [ ] **Step 4: Montarlo en `src/app.js`**

Agregar el import y el mount junto a los existentes:

```js
import { categoriesRouter } from './routes/categories.js'
```

```js
  app.use('/api/categories', categoriesRouter({ db, config }))
```

- [ ] **Step 5: Correr toda la suite**

Run: `npx vitest run`
Expected: PASS completo.

- [ ] **Step 6: Commit**

```bash
git add src/routes/categories.js src/app.js test/routes/categories.test.js
git commit -m "feat: API /api/categories (CRUD con Otros protegida)"
```

---

### Task 5: Frontend home — categorías dinámicas + popover de dos pasos

**Files:**
- Modify: `public/app.js` (CATS dinámico, popover con paso de alcance)
- Modify: `public/styles.css` (estilos del paso de alcance)

**Interfaces:**
- Consumes: `GET /api/categories` (Task 4), `PATCH /api/expenses/:id { category, learn? }` (Task 2).
- Produces: nada que consuman otras tasks.

Nota: no hay harness de tests de UI en este proyecto — la verificación es manual contra el server local.

- [ ] **Step 1: CATS dinámico en `public/app.js`**

Reemplazar las líneas 3-14 (const `CATS`, `COLOR`, `colorOf`) por:

```js
// Las categorías (nombre + color) viven en la DB y se cargan por API.
let CATS = []
let COLOR = {}
const colorOf = (name) => COLOR[name] || '#71717a'

async function loadCategories() {
  const res = await fetch('/api/categories')
  if (!res.ok) return
  const data = await res.json()
  CATS = data.categories
  COLOR = Object.fromEntries(CATS.map((c) => [c.name, c.color]))
}
```

Y en `load()` (línea ~57), cargar categorías antes de renderizar:

```js
async function load() {
  const res = await fetch(`/api/expenses?month=${currentMonth}`)
  if (res.status === 401) return showLogin()
  await loadCategories()
  const data = await res.json()
  lastData = data
  showApp()
  $('#month-label').textContent = monthLabel(currentMonth)
  render(data)
}
```

- [ ] **Step 2: Popover de dos pasos**

Reemplazar la función `openCatMenu` completa (líneas 166-198) por:

```js
function openCatMenu(anchor, id, current) {
  menu.innerHTML = CATS.map(
    (c) => `<button data-name="${c.name}" aria-current="${c.name === current}">
      <span class="dot" style="background:${c.color}"></span>${c.name}
      <span class="check">✓</span>
    </button>`
  ).join('')
  positionMenu(anchor)

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const name = b.dataset.name
      if (name === current) return closeMenu()
      openScopeStep(anchor, id, name)
    })
  })
}

// Paso 2: elegir alcance. "Solo este gasto" = PATCH normal; "Siempre este
// comercio" = learn:true (aprende la regla y pisa el histórico del comercio).
function openScopeStep(anchor, id, category) {
  const exp = lastData.expenses.find((e) => e.id === id)
  const merchant = exp ? exp.merchant : ''
  menu.innerHTML = `
    <div class="scope-head">${escape(merchant)} → <span class="scope-cat" style="color:${colorOf(category)}">${category}</span></div>
    <button data-scope="one">Solo este gasto</button>
    <button data-scope="always">Siempre este comercio</button>
  `
  positionMenu(anchor)

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const learn = b.dataset.scope === 'always'
      closeMenu()
      const res = await fetch(`/api/expenses/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(learn ? { category, learn: true } : { category }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || 'No se pudo guardar')
      }
      load()
    })
  })
}

// Posiciona el popover pegado al anchor; si no entra abajo, abre hacia arriba.
function positionMenu(anchor) {
  const r = anchor.getBoundingClientRect()
  menu.classList.remove('hidden')
  const mh = menu.offsetHeight
  const below = r.bottom + 6
  const top = below + mh > window.innerHeight ? r.top - mh - 6 : below
  menu.style.top = `${Math.max(8, top)}px`
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`
}
```

(`positionMenu` extrae el código de posicionamiento que estaba inline en `openCatMenu`; el resto del archivo no cambia.)

- [ ] **Step 3: Estilos del paso de alcance en `public/styles.css`**

Agregar al final, junto a los estilos de `.catmenu`:

```css
/* paso 2 del popover: alcance de la recategorización */
.catmenu .scope-head {
  padding: 8px 12px 6px;
  font-size: 12px;
  color: var(--muted, #71717a);
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catmenu .scope-cat {
  font-weight: 600;
}
```

(Si `styles.css` no define `--muted`, usar el gris literal `#71717a`.)

- [ ] **Step 4: Verificación manual**

```bash
npm run dev
```

En el navegador (localhost, puerto del server):
1. Login → el ledger carga y los colores de categoría se ven igual que antes (ahora vienen de la API — verificar en Network que `GET /api/categories` responde).
2. Click en la categoría de un gasto → elegir otra → aparece el paso "Solo este gasto / Siempre este comercio".
3. "Solo este gasto" → cambia solo esa fila.
4. En otro gasto, "Siempre este comercio" → cambian todas las filas de ese comercio (probar con dos gastos del mismo merchant, se pueden inyectar por `POST /api/ingest` o con `sqlite3`).
5. Escape y click afuera cancelan sin cambios.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: popover de recategorización con alcance (solo este / siempre) y categorías desde la API"
```

---

### Task 6: Menú hamburguesa + página de categorías

**Files:**
- Modify: `public/index.html` (botón hamburguesa + menú desplegable)
- Modify: `public/app.js` (toggle del menú)
- Create: `public/categorias.html`
- Create: `public/categorias.js`
- Modify: `public/styles.css` (menú + página de categorías)

**Interfaces:**
- Consumes: API completa de Task 4.
- Produces: nada que consuman otras tasks.

- [ ] **Step 1: Hamburguesa en `public/index.html`**

En el `<header class="topbar">` (líneas 37-44), después del `</nav>`, agregar:

```html
        <div class="menuwrap">
          <button id="menu-btn" class="step" aria-label="Menú" aria-expanded="false">☰</button>
          <nav id="mainmenu" class="mainmenu hidden">
            <a href="/categorias.html">Categorías</a>
          </nav>
        </div>
```

- [ ] **Step 2: Toggle del menú en `public/app.js`**

Agregar en la sección `/* ---------- eventos ---------- */`:

```js
// menú hamburguesa
const menuBtn = $('#menu-btn')
const mainMenu = $('#mainmenu')
menuBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  const open = mainMenu.classList.toggle('hidden')
  menuBtn.setAttribute('aria-expanded', String(!open))
})
document.addEventListener('click', () => mainMenu.classList.add('hidden'))
```

- [ ] **Step 3: Crear `public/categorias.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>gastaker · categorías</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div id="app" class="app">
      <header class="topbar">
        <a class="wordmark sm" href="/" style="text-decoration: none">gastaker<span class="caret">_</span></a>
        <span class="overline">Categorías</span>
      </header>

      <section class="ledger">
        <form id="new-cat" class="newcat">
          <input id="new-name" type="text" placeholder="Nueva categoría" maxlength="30" required />
          <div id="palette" class="palette"></div>
          <button type="submit">Crear</button>
          <p id="form-error" class="login-error hidden"></p>
        </form>

        <div id="cats" class="cats"></div>
      </section>
    </div>

    <script src="/categorias.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Crear `public/categorias.js`**

```js
/* gastaker — gestión de categorías (crear / renombrar / borrar). */

const $ = (s) => document.querySelector(s)

// Paleta preset para elegir color (los 8 seed + 4 extra).
const PALETTE = [
  '#FF6B35', '#06B6D4', '#4F46E5', '#A855F7', '#EC4899', '#10B981',
  '#F59E0B', '#64748B', '#EF4444', '#84CC16', '#14B8A6', '#8B5CF6',
]
let selectedColor = PALETTE[0]
let cats = []

function escape(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (res.status === 401) {
    location.href = '/' // sin sesión: al home a loguear
    throw new Error('sin sesión')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'error')
  return body
}

async function load() {
  const data = await api('/api/categories')
  cats = data.categories
  render()
}

function render() {
  renderPalette()
  $('#cats').innerHTML = cats
    .map((c) => {
      const protegida = c.name === 'Otros'
      const acciones = protegida
        ? '<span class="cat-lock" title="Categoría fija">fija</span>'
        : `<button class="cat-action" data-act="rename" data-id="${c.id}">Renombrar</button>
           <button class="cat-action danger" data-act="delete" data-id="${c.id}">Borrar</button>`
      return `<div class="cat-row">
        <span class="dot" style="background:${c.color}"></span>
        <span class="cat-name">${escape(c.name)}</span>
        <span class="cat-count">${c.count} ${c.count === 1 ? 'gasto' : 'gastos'}</span>
        ${acciones}
      </div>`
    })
    .join('')

  $('#cats').querySelectorAll('.cat-action').forEach((b) => {
    const cat = cats.find((c) => c.id === Number(b.dataset.id))
    b.addEventListener('click', () => (b.dataset.act === 'rename' ? rename(cat) : remove(cat)))
  })
}

function renderPalette() {
  $('#palette').innerHTML = PALETTE.map(
    (color) => `<button type="button" class="swatch${color === selectedColor ? ' sel' : ''}"
      style="background:${color}" data-color="${color}" aria-label="${color}"></button>`
  ).join('')
  $('#palette').querySelectorAll('.swatch').forEach((s) => {
    s.addEventListener('click', () => {
      selectedColor = s.dataset.color
      renderPalette()
    })
  })
}

async function rename(cat) {
  const nuevo = prompt(`Renombrar "${cat.name}" a:`, cat.name)
  if (!nuevo || nuevo.trim() === cat.name) return
  try {
    await api(`/api/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ name: nuevo.trim() }) })
    load()
  } catch (e) {
    alert(e.message)
  }
}

async function remove(cat) {
  const msg = cat.count
    ? `${cat.count} ${cat.count === 1 ? 'gasto va' : 'gastos van'} a pasar a "Otros". ¿Borrar "${cat.name}"?`
    : `¿Borrar "${cat.name}"?`
  if (!confirm(msg)) return
  try {
    await api(`/api/categories/${cat.id}`, { method: 'DELETE' })
    load()
  } catch (e) {
    alert(e.message)
  }
}

$('#new-cat').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const errEl = $('#form-error')
  errEl.classList.add('hidden')
  try {
    await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: $('#new-name').value, color: selectedColor }),
    })
    $('#new-name').value = ''
    load()
  } catch (e) {
    errEl.textContent = e.message
    errEl.classList.remove('hidden')
  }
})

load()
```

- [ ] **Step 5: Estilos en `public/styles.css`**

Agregar al final:

```css
/* ---------- menú hamburguesa ---------- */
.menuwrap {
  position: relative;
}
.mainmenu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  background: var(--bg2, #18181b);
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 10px;
  padding: 6px;
  min-width: 160px;
  z-index: 30;
}
.mainmenu a {
  display: block;
  padding: 8px 12px;
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
  font-size: 14px;
}
.mainmenu a:hover {
  background: rgba(128, 128, 128, 0.12);
}

/* ---------- página de categorías ---------- */
.newcat {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}
.newcat input[type='text'] {
  flex: 1;
  min-width: 160px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  background: transparent;
  color: inherit;
  font: inherit;
}
.newcat button[type='submit'] {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font: inherit;
}
.palette {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.swatch.sel {
  border-color: currentColor;
}
.cats {
  display: flex;
  flex-direction: column;
}
.cat-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}
.cat-name {
  font-weight: 500;
}
.cat-count {
  margin-left: auto;
  font-size: 12px;
  color: #71717a;
}
.cat-action {
  background: none;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: inherit;
  font-size: 12px;
}
.cat-action.danger {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
}
.cat-lock {
  font-size: 12px;
  color: #71717a;
}
```

(Ajustar los colores de fondo/borde a las variables reales de `styles.css` si existen — mirar cómo está estilado `.catmenu` y copiar su fondo/borde para `.mainmenu`.)

- [ ] **Step 6: Verificación manual**

```bash
npm run dev
```

1. Home → botón ☰ en el header abre el menú → "Categorías" navega a `/categorias.html`.
2. La página lista las 8 categorías con color y contador; `Otros` figura como "fija" sin botones.
3. Crear "Ropa" con un color → aparece en la lista; volver al home → "Ropa" está disponible en el popover de recategorización.
4. Renombrar "Ropa" → los gastos que la usaban (si hay) muestran el nombre nuevo en el home.
5. Borrar "Ropa" con gastos → confirma cuántos pasan a "Otros" y lo hace.
6. Crear duplicado ("comida") → muestra el error 409 en el form.
7. Deslogueado (borrar cookie) → `/categorias.html` redirige al home.

- [ ] **Step 7: Correr la suite completa y commit**

Run: `npx vitest run`
Expected: PASS completo.

```bash
git add public/index.html public/app.js public/categorias.html public/categorias.js public/styles.css
git commit -m "feat: menú hamburguesa y página de gestión de categorías"
```
