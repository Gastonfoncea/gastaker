// test/manual-expense.test.js — alta manual de gastos y borrado (solo manuales).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { makeUserDb, makeAppWithUser, authedAgent } from './helpers.js'

// Mes actual con el mismo reloj (hora argentina) que usa el POST para occurred_at.
const mesActual = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit' })
    .format(new Date())

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
    const res = await agent.get(`/api/expenses?month=${mesActual()}`)
    expect(res.body.expenses).toHaveLength(1)
    expect(res.body.totals).toEqual({ Comida: 5000 })
  })

  it('occurred_at queda en hora argentina (YYYY-MM-DDTHH:mm:ss, mes actual)', async () => {
    const res = await agent.post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    const { occurred_at } = res.body.expense
    expect(occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(occurred_at.startsWith(mesActual())).toBe(true)
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
    const res = await agent.get(`/api/expenses?month=${mesActual()}`)
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
    const res = await agent.get(`/api/expenses?month=${mesActual()}`)
    expect(res.body.expenses).toHaveLength(2)
  })

  it('sin sesión -> 401', async () => {
    const res = await request(app).post('/api/expenses').send({ amount: 100, merchant: 'X', category: 'Comida' })
    expect(res.status).toBe(401)
  })
})

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
