# Carga manual de gastos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poder crear gastos a mano desde la web (popover con monto/comercio/categoría) y borrar los gastos manuales si salieron mal.

**Architecture:** Un gasto manual es una fila más de `expenses` con `source='manual'` y un `gmail_message_id` sintético (`manual-<token>`), así no cambia el esquema ni ningún cálculo existente. Dos endpoints nuevos en el router de expenses (POST y DELETE), y en el frontend un botón `+` que abre el popover existente (`#catmenu`) con un mini form.

**Tech Stack:** Node + Express + better-sqlite3, frontend vanilla JS, tests con vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-07-21-gastos-manuales-design.md`

## Global Constraints

- Comentarios y mensajes de error en español, mismo tono que el código existente.
- ESM (`import`/`export`), sin dependencias nuevas.
- Commits estilo conventional en español (`feat:`, `fix:`), como el historial.
- Los tests nuevos van todos en `test/manual-expense.test.js` y usan los helpers de `test/helpers.js` (`makeUserDb`, `makeAppWithUser`, `authedAgent`).
- Correr tests: `npx vitest run test/manual-expense.test.js` (suite completa: `npx vitest run`).

---

### Task 1: DB — `insert()` devuelve el id y `deleteExpense()`

**Files:**
- Modify: `src/db.js` (método `insert` ~línea 237, agregar `deleteExpense` después de `getExpense` ~línea 256)
- Test: `test/manual-expense.test.js` (crear)

**Interfaces:**
- Consumes: `makeUserDb()` de `test/helpers.js` → `{ db, user, udb }`.
- Produces: `udb.insert(record)` → `{ inserted: boolean, id: number }` (`id` = `lastInsertRowid`, solo tiene sentido si `inserted === true`). `udb.deleteExpense(id)` → `boolean` (borra solo filas del propio user). Task 2 usa `insert().id`; Task 3 usa `deleteExpense`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/manual-expense.test.js`:

```js
// test/manual-expense.test.js — alta manual de gastos y borrado (solo manuales).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { makeUserDb, makeAppWithUser, authedAgent } from './helpers.js'

const gasto = (over = {}) => ({
  gmail_message_id: `m-${Math.random()}`,
  amount: 100,
  merchant: 'X',
  category: 'Comida',
  occurred_at: '2026-07-01T10:00:00',
  ...over,
})

describe('db: insert() devuelve id y deleteExpense()', () => {
  it('insert() devuelve el id de la fila insertada', () => {
    const { udb } = makeUserDb()
    const r = udb.insert(gasto())
    expect(r.inserted).toBe(true)
    expect(udb.getExpense(r.id).merchant).toBe('X')
  })

  it('deleteExpense() borra el gasto propio y devuelve true', () => {
    const { udb } = makeUserDb()
    const r = udb.insert(gasto())
    expect(udb.deleteExpense(r.id)).toBe(true)
    expect(udb.getExpense(r.id)).toBeUndefined()
  })

  it('deleteExpense() no borra gastos de otro usuario', () => {
    const { db, udb } = makeUserDb()
    const r = udb.insert(gasto())
    const otro = db.createUser({ email: 'otro@test.com', password: 'x' })
    expect(db.forUser(otro.id).deleteExpense(r.id)).toBe(false)
    expect(udb.getExpense(r.id)).toBeDefined()
  })
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run test/manual-expense.test.js`
Expected: FAIL — el primer test falla porque `r.id` es `undefined`; los otros dos porque `udb.deleteExpense` no es una función.

- [ ] **Step 3: Implementar en `src/db.js`**

En el método `insert` de `forUser` (~línea 237), cambiar el return:

```js
      // Devuelve { inserted, id }. inserted=false si el (user_id, gmail_message_id)
      // ya existía; id solo tiene sentido cuando inserted=true.
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
        return { inserted: info.changes > 0, id: Number(info.lastInsertRowid) }
      },
```

Después de `getExpense` (~línea 256), agregar:

```js
      // Borra un gasto propio. Devuelve true si borró. El chequeo de que sea
      // manual lo hace la ruta (acá el método queda genérico y scopeado).
      deleteExpense(id) {
        return sqlite.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
      },
```

- [ ] **Step 4: Verificar que pasan (y que nada se rompió)**

Run: `npx vitest run`
Expected: PASS todo (los llamadores existentes de `insert()` solo miran `inserted`).

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/manual-expense.test.js
git commit -m "feat(db): insert() devuelve el id insertado y deleteExpense() scopeado"
```

---

### Task 2: API — `POST /api/expenses`

**Files:**
- Modify: `src/routes/expenses.js` (import de `randomToken` arriba, ruta nueva después del GET)
- Test: `test/manual-expense.test.js` (append)

**Interfaces:**
- Consumes: `udb.insert()` → `{ inserted, id }` (Task 1), `udb.getExpense(id)`, `udb.listCategories()` (existente), `randomToken(bytes)` de `src/crypto.js`.
- Produces: `POST /api/expenses` con body `{ amount, merchant, category }` → 201 `{ expense: <fila completa> }`, o 400 `{ error }`. El frontend (Task 4) consume este endpoint.

- [ ] **Step 1: Escribir los tests que fallan**

Append a `test/manual-expense.test.js`:

```js
describe('POST /api/expenses', () => {
  let db, user, app, agent
  beforeEach(async () => {
    ;({ db, user, app } = makeAppWithUser())
    agent = await authedAgent(app)
  })

  it('crea el gasto manual con los defaults correctos', async () => {
    const res = await agent.post('/api/expenses').send({ amount: 5000, merchant: 'Verdulería', category: 'Comida' })
    expect(res.status).toBe(201)
    const e = res.body.expense
    expect(e.amount).toBe(5000)
    expect(e.merchant).toBe('Verdulería')
    expect(e.category).toBe('Comida')
    expect(e.source).toBe('manual')
    expect(e.payment_method).toBeNull()
    expect(e.currency).toBe('ARS')
    expect(e.needs_review).toBe(0)
    expect(e.gmail_message_id.startsWith('manual-')).toBe(true)
  })

  it('aparece en el listado del mes y suma al total', async () => {
    await agent.post('/api/expenses').send({ amount: 5000, merchant: 'Verdulería', category: 'Comida' })
    const month = new Date().toISOString().slice(0, 7) // mismo reloj (UTC) que occurred_at
    const res = await agent.get(`/api/expenses?month=${month}`)
    expect(res.body.expenses).toHaveLength(1)
    expect(res.body.totals).toEqual({ Comida: 5000 })
  })

  it('acepta la categoría con otra capitalización y guarda el nombre canónico', async () => {
    const res = await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'comida' })
    expect(res.status).toBe(201)
    expect(res.body.expense.category).toBe('Comida')
  })

  it('monto no numérico, cero o ausente -> 400', async () => {
    for (const amount of ['5000', 0, null, undefined]) {
      const res = await agent.post('/api/expenses').send({ amount, merchant: 'X', category: 'Comida' })
      expect(res.status).toBe(400)
    }
  })

  it('monto negativo se acepta y resta del total', async () => {
    await agent.post('/api/expenses').send({ amount: 5000, merchant: 'X', category: 'Comida' })
    await agent.post('/api/expenses').send({ amount: -2000, merchant: 'X', category: 'Comida' })
    const month = new Date().toISOString().slice(0, 7)
    const res = await agent.get(`/api/expenses?month=${month}`)
    expect(res.body.totals).toEqual({ Comida: 3000 })
  })

  it('comercio vacío -> 400', async () => {
    const res = await agent.post('/api/expenses').send({ amount: 100, merchant: '   ', category: 'Comida' })
    expect(res.status).toBe(400)
  })

  it('categoría inexistente -> 400', async () => {
    const res = await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'NoExiste' })
    expect(res.status).toBe(400)
  })

  it('dos POST idénticos crean dos gastos (ids sintéticos distintos)', async () => {
    await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    const month = new Date().toISOString().slice(0, 7)
    const res = await agent.get(`/api/expenses?month=${month}`)
    expect(res.body.expenses).toHaveLength(2)
  })

  it('sin sesión -> 401', async () => {
    const res = await request(app).post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run test/manual-expense.test.js`
Expected: FAIL — los POST devuelven 404 (la ruta no existe). El test de 401 puede pasar ya (requireAuth cubre todo el router); está bien.

- [ ] **Step 3: Implementar la ruta**

En `src/routes/expenses.js`, agregar el import arriba:

```js
import { randomToken } from '../crypto.js'
```

Y después del `router.get('/', ...)`, la ruta nueva:

```js
  // POST /api/expenses  { amount, merchant, category } -> 201 { expense }
  // Alta manual: source='manual', fecha=ahora, ARS, cuenta como débito
  // (payment_method NULL). El gmail_message_id sintético satisface el UNIQUE.
  router.post('/', (req, res) => {
    const udb = db.forUser(req.userId)
    const { amount, merchant, category } = req.body || {}
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'monto inválido' })
    }
    const m = (merchant || '').trim()
    if (!m) return res.status(400).json({ error: 'falta el comercio' })
    const wanted = String(category || '').trim().toLowerCase()
    const cat = udb.listCategories().find((c) => c.name.toLowerCase() === wanted)
    if (!cat) return res.status(400).json({ error: `no existe la categoría "${category}"` })

    const { id } = udb.insert({
      gmail_message_id: `manual-${randomToken(12)}`,
      amount,
      merchant: m,
      category: cat.name,
      occurred_at: new Date().toISOString().slice(0, 19),
      source: 'manual',
    })
    res.status(201).json({ expense: udb.getExpense(id) })
  })
```

- [ ] **Step 4: Verificar que pasan**

Run: `npx vitest run test/manual-expense.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/expenses.js test/manual-expense.test.js
git commit -m "feat(api): POST /api/expenses para alta manual de gastos"
```

---

### Task 3: API — `DELETE /api/expenses/:id` (solo manuales)

**Files:**
- Modify: `src/routes/expenses.js` (ruta nueva después del POST de Task 2)
- Test: `test/manual-expense.test.js` (append)

**Interfaces:**
- Consumes: `udb.getExpense(id)` (existente), `udb.deleteExpense(id)` (Task 1).
- Produces: `DELETE /api/expenses/:id` → 200 `{ ok: true }` | 404 `{ error }` (no existe o es de otro user) | 400 `{ error }` (no es manual). El frontend (Task 4) consume este endpoint.

- [ ] **Step 1: Escribir los tests que fallan**

Append a `test/manual-expense.test.js`:

```js
describe('DELETE /api/expenses/:id', () => {
  let db, user, app, agent
  beforeEach(async () => {
    ;({ db, user, app } = makeAppWithUser())
    agent = await authedAgent(app)
  })

  const crearManual = async () => {
    const res = await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    return res.body.expense.id
  }

  it('borra un gasto manual', async () => {
    const id = await crearManual()
    const res = await agent.delete(`/api/expenses/${id}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(db.forUser(user.id).getExpense(id)).toBeUndefined()
  })

  it('un gasto que vino del mail -> 400 y no se borra', async () => {
    const { id } = db.forUser(user.id).insert(gasto()) // source default: 'santander'
    const res = await agent.delete(`/api/expenses/${id}`)
    expect(res.status).toBe(400)
    expect(db.forUser(user.id).getExpense(id)).toBeDefined()
  })

  it('gasto de otro usuario -> 404 y no se borra', async () => {
    const otro = db.createUser({ email: 'otro@test.com', password: 'x' })
    const { id } = db.forUser(otro.id).insert(gasto({ source: 'manual' }))
    const res = await agent.delete(`/api/expenses/${id}`)
    expect(res.status).toBe(404)
    expect(db.forUser(otro.id).getExpense(id)).toBeDefined()
  })

  it('inexistente -> 404', async () => {
    const res = await agent.delete('/api/expenses/99999')
    expect(res.status).toBe(404)
  })

  it('sin sesión -> 401', async () => {
    const id = await crearManual()
    const res = await request(app).delete(`/api/expenses/${id}`)
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run test/manual-expense.test.js`
Expected: FAIL — los DELETE devuelven 404 genérico de Express en todos los casos, así que fallan "borra un gasto manual" (espera 200) y "un gasto que vino del mail" (espera 400).

- [ ] **Step 3: Implementar la ruta**

En `src/routes/expenses.js`, después del POST:

```js
  // DELETE /api/expenses/:id — solo gastos manuales; los del mail son historial
  // del banco y no se tocan.
  router.delete('/:id', (req, res) => {
    const udb = db.forUser(req.userId)
    const id = Number.parseInt(req.params.id, 10)
    const expense = udb.getExpense(id)
    if (!expense) return res.status(404).json({ error: 'no encontrado' })
    if (expense.source !== 'manual') {
      return res.status(400).json({ error: 'solo se pueden borrar gastos manuales' })
    }
    udb.deleteExpense(id)
    res.json({ ok: true })
  })
```

- [ ] **Step 4: Verificar que pasan (suite completa)**

Run: `npx vitest run`
Expected: PASS todo.

- [ ] **Step 5: Commit**

```bash
git add src/routes/expenses.js test/manual-expense.test.js
git commit -m "feat(api): DELETE /api/expenses/:id borra gastos manuales"
```

---

### Task 4: Frontend — botón `+`, popover de alta, badge "manual" y eliminar

**Files:**
- Modify: `public/index.html` (header de Movimientos, ~línea 67-74)
- Modify: `public/app.js` (badge en `render()`, form de alta, opción eliminar en `openCatMenu()`)
- Modify: `public/styles.css` (form del popover, badge, opción destructiva)

**Interfaces:**
- Consumes: `POST /api/expenses` (Task 2) y `DELETE /api/expenses/:id` (Task 3); helpers existentes de `app.js`: `positionMenu(anchor)`, `closeMenu()`, `load()`, `CATS`, `lastData`, `escape()`.
- Produces: UI final; nada posterior depende de esto.

- [ ] **Step 1: Botón `+` en `public/index.html`**

Reemplazar el bloque `.ledger-head` (líneas 68-74) por:

```html
        <div class="ledger-head">
          <div class="ledger-head-left">
            <span class="overline">Movimientos</span>
            <span id="movs-count" class="movs-count"></span>
          </div>
          <div class="ledger-head-right">
            <button id="add-btn" class="step" aria-label="Agregar gasto">+</button>
            <select id="cat-filter" class="cat-filter" aria-label="Filtrar por categoría"></select>
          </div>
        </div>
```

- [ ] **Step 2: Form de alta en `public/app.js`**

Después del bloque `/* ---------- popover de categorías ---------- */` (las funciones `openCatMenu`/`openScopeStep`), agregar:

```js
/* ---------- alta manual ---------- */
// Reusa el popover #catmenu: el contenido es un mini form (monto/comercio/categoría).
function openAddMenu(anchor) {
  mainMenu.classList.add('hidden')
  menu.innerHTML = `
    <form id="add-form" class="add-form">
      <input id="add-amount" inputmode="decimal" placeholder="Monto" autocomplete="off" />
      <input id="add-merchant" type="text" placeholder="Comercio" autocomplete="off" />
      <select id="add-cat">
        ${CATS.map((c) => `<option value="${escape(c.name)}">${escape(c.name)}</option>`).join('')}
      </select>
      <p id="add-error" class="add-error hidden"></p>
      <button type="submit" class="add-submit">Agregar</button>
    </form>
  `
  positionMenu(anchor)
  const form = menu.querySelector('#add-form')
  // que los clicks dentro del form no burbujeen al closeMenu global del document
  form.addEventListener('click', (ev) => ev.stopPropagation())
  $('#add-amount').focus()

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    // es-AR: coma decimal -> punto, para que Number() la entienda
    const amount = Number($('#add-amount').value.trim().replace(',', '.'))
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, merchant: $('#add-merchant').value.trim(), category: $('#add-cat').value }),
    })
    if (res.ok) {
      closeMenu()
      load()
    } else {
      const err = await res.json().catch(() => ({}))
      const el = $('#add-error')
      el.textContent = err.error || 'No se pudo guardar'
      el.classList.remove('hidden')
    }
  })
}
```

Y en la sección `/* ---------- eventos ---------- */`, junto a los otros listeners:

```js
$('#add-btn').addEventListener('click', (ev) => {
  ev.stopPropagation()
  openAddMenu(ev.currentTarget)
})
```

- [ ] **Step 3: Badge "manual" en `render()`**

En `public/app.js`, dentro del `.map()` de las filas del ledger, después de la línea `const credito = ...`:

```js
          const manual = e.source === 'manual' ? '<span class="row-manual">manual</span>' : ''
```

Y en el template de la fila, sumarlo junto a los otros badges:

```js
            <div class="cell-merchant">
              <span class="row-merchant">${escape(e.merchant)}</span>${card}${credito}${manual}
            </div>
```

- [ ] **Step 4: Opción "Eliminar gasto" en `openCatMenu()`**

Reemplazar `openCatMenu` en `public/app.js` por:

```js
function openCatMenu(anchor, id, current) {
  mainMenu.classList.add('hidden') // si el hamburguesa estaba abierto, no lo dejamos detrás del popover
  const exp = lastData.expenses.find((e) => e.id === id)
  // los gastos manuales se pueden borrar; los del mail son historial del banco
  const del = exp && exp.source === 'manual' ? '<button class="cat-delete" data-del="1">Eliminar gasto</button>' : ''
  menu.innerHTML =
    CATS.map(
      (c) => `<button data-name="${c.name}" aria-current="${c.name === current}">
      <span class="dot" style="background:${c.color}"></span>${c.name}
      <span class="check">✓</span>
    </button>`
    ).join('') + del
  positionMenu(anchor)

  menu.querySelectorAll('button[data-name]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const name = b.dataset.name
      if (name === current) return closeMenu()
      openScopeStep(anchor, id, name)
    })
  })

  const delBtn = menu.querySelector('[data-del]')
  if (delBtn) {
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      closeMenu()
      if (!confirm('¿Eliminar este gasto?')) return
      const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || 'No se pudo borrar')
      }
      load()
    })
  }
}
```

(El cambio en el selector de los botones de categoría — `button[data-name]` en vez de `button` — evita engancharle el listener de recategorizar al botón de borrar.)

- [ ] **Step 5: Estilos en `public/styles.css`**

Cambiar el selector del badge crédito (línea ~430) para compartirlo:

```css
/* badges "crédito" (se ve pero no suma) y "manual" (cargado a mano) */
.row-credito,
.row-manual {
  font-size: 11px;
  color: var(--ink-3);
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
  flex: none;
}
```

Después del bloque `.ledger-head-left` (~línea 323), agregar:

```css
.ledger-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

Al final de la sección CATEGORY POPOVER, agregar:

```css
/* form de alta manual dentro del popover */
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
  width: 220px;
}
.add-form input,
.add-form select {
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 10px;
}
.add-form input:focus,
.add-form select:focus {
  outline: none;
  border-color: var(--ink);
}
.add-form .add-submit {
  display: block;
  font-weight: 500;
  color: #fff;
  background: var(--ink);
  border: none;
  cursor: pointer;
  text-align: center;
  padding: 8px 10px;
  border-radius: 8px;
  transition: opacity 0.15s var(--ease);
}
.add-form .add-submit:hover {
  opacity: 0.85;
}
.add-error {
  font-size: 12px;
  color: #dc2626;
  margin: 0;
}

/* opción destructiva del popover: eliminar un gasto manual */
.catmenu .cat-delete {
  color: #dc2626;
  margin-top: 4px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0;
}
```

(Nota: `.add-form .add-submit` y `.catmenu .cat-delete` heredan también las reglas de `.catmenu button` — display flex, padding, hover con fondo — por eso solo se pisa lo que cambia.)

- [ ] **Step 6: Verificación manual end-to-end**

```bash
npm start
```

En el navegador (`http://localhost:3000` o el puerto configurado), logueado:
1. Click en `+` → aparece el popover con monto/comercio/categoría, foco en monto.
2. Cargar `5000` / `Verdulería` / `Comida` → Agregar → el popover se cierra, la fila aparece con badge "manual" y el total del mes sube $5.000.
3. Cargar un monto con coma (`1234,56`) → se guarda como 1234.56.
4. Dejar el monto vacío → Agregar → error inline "monto inválido", el popover no se cierra.
5. Click en la categoría de la fila manual → el popover muestra "Eliminar gasto" al final → confirmar → la fila desaparece y el total baja.
6. Click en la categoría de una fila que vino del mail → NO aparece "Eliminar gasto" y recategorizar sigue funcionando (ambos alcances).
7. Esc y click afuera cierran el popover de alta.

- [ ] **Step 7: Suite completa y commit**

Run: `npx vitest run`
Expected: PASS todo.

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): alta manual de gastos (popover +), badge manual y eliminar"
```
