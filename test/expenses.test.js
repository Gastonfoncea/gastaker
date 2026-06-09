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
