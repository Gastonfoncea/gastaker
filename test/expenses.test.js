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

  it.skip('GET /api/expenses sin cookie da 401', async () => {
    const res = await request(app).get('/api/expenses?month=2026-06')
    expect(res.status).toBe(401)
  })
})
