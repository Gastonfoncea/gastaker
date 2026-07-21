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
