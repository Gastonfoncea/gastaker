// test/expenses.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { TEST_CONFIG, authedAgent } from './helpers.js'

// db + user + app. El user tiene email/password y un ingest_token para seedear.
function makeCtx({ email = 'test@test.com', password = 'clave-test' } = {}) {
  const db = createDb(':memory:')
  const user = db.createUser({ email, password })
  const app = createApp({ db, config: TEST_CONFIG })
  return { db, user, app }
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

async function seedExpense(app, token) {
  await request(app).post('/api/ingest').set('X-Webhook-Secret', token).send({ messageId: 'm1', body: SAMPLE })
}

describe('auth', () => {
  let app
  beforeEach(() => {
    app = makeCtx().app
  })

  it('login con email+password correctos devuelve cookie', async () => {
    const res = await request(app).post('/api/login').send({ email: 'test@test.com', password: 'clave-test' })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie'].join()).toContain('gastaker_auth')
  })

  it('login con credenciales incorrectas da 401', async () => {
    expect((await request(app).post('/api/login').send({ email: 'test@test.com', password: 'mal' })).status).toBe(401)
    expect((await request(app).post('/api/login').send({ email: 'nadie@test.com', password: 'clave-test' })).status).toBe(401)
  })

  it('GET /api/expenses sin cookie da 401', async () => {
    const res = await request(app).get('/api/expenses?month=2026-06')
    expect(res.status).toBe(401)
  })

  it('logout invalida la sesión (un GET posterior da 401)', async () => {
    const agent = await authedAgent(app)
    expect((await agent.get('/api/expenses?month=2026-06')).status).toBe(200)
    await agent.post('/api/logout')
    expect((await agent.get('/api/expenses?month=2026-06')).status).toBe(401)
  })
})

describe('GET /api/expenses', () => {
  it('lista los gastos del mes con totales por categoría', async () => {
    const { app, user } = makeCtx()
    await seedExpense(app, user.ingest_token)
    const agent = await authedAgent(app)
    const res = await agent.get('/api/expenses?month=2026-06')
    expect(res.status).toBe(200)
    expect(res.body.expenses).toHaveLength(1)
    expect(res.body.totals).toEqual({ Comida: 12946.0 })
  })
})

describe('PATCH /api/expenses/:id', () => {
  it('cambia la categoría de un gasto y limpia needs_review', async () => {
    const { app, user } = makeCtx()
    await seedExpense(app, user.ingest_token)
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
    const { db, app, user } = makeCtx()
    const udb = db.forUser(user.id)
    udb.insert({ gmail_message_id: 'a', amount: 100, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    udb.insert({ gmail_message_id: 'b', amount: 200, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-02T10:00:00' })
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const [first, second] = list.body.expenses // orden: más reciente primero
    await agent.patch(`/api/expenses/${first.id}`).send({ category: 'Transporte' })
    const after = await agent.get('/api/expenses?month=2026-06')
    const otro = after.body.expenses.find((e) => e.id === second.id)
    expect(otro.category).toBe('Otros')
  })

  it('con learn aprende la regla y pisa todos los gastos del comercio', async () => {
    const { db, app, user } = makeCtx()
    const udb = db.forUser(user.id)
    udb.insert({ gmail_message_id: 'a', amount: 100, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    udb.insert({ gmail_message_id: 'b', amount: 200, merchant: 'PAYU*AR*UBER', category: 'Otros', occurred_at: '2026-06-02T10:00:00', needs_review: 1 })
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
    expect(udb.findLearned('PAYU*AR*UBER')).toBe('Transporte')
  })

  it('con learn y un merchant no registrable (genérico) devuelve 400', async () => {
    const { db, app, user } = makeCtx()
    const udb = db.forUser(user.id)
    udb.insert({ gmail_message_id: 'a', amount: 100, merchant: 'Transferencia', category: 'Otros', occurred_at: '2026-06-01T10:00:00' })
    const agent = await authedAgent(app)
    const list = await agent.get('/api/expenses?month=2026-06')
    const id = list.body.expenses[0].id
    const res = await agent.patch(`/api/expenses/${id}`).send({ category: 'Comida', learn: true })
    expect(res.status).toBe(400)
    const after = await agent.get('/api/expenses?month=2026-06')
    expect(after.body.expenses[0].category).toBe('Otros')
  })

  it('gasto inexistente devuelve 404', async () => {
    const { app } = makeCtx()
    const agent = await authedAgent(app)
    const res = await agent.patch('/api/expenses/9999').send({ category: 'Comida' })
    expect(res.status).toBe(404)
  })
})
