// test/me.test.js — GET/PATCH /api/me.
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { TEST_CONFIG, authedAgent } from './helpers.js'

describe('/api/me', () => {
  let db, app
  beforeEach(() => {
    db = createDb(':memory:')
    db.createUser({ email: 'test@test.com', password: 'clave-test' })
    app = createApp({ db, config: TEST_CONFIG })
  })

  it('sin auth da 401', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401)
  })

  it('GET devuelve email, ingest_token, whatsapp_number e is_admin', async () => {
    const agent = await authedAgent(app)
    const res = await agent.get('/api/me')
    expect(res.status).toBe(200)
    expect(res.body.email).toBe('test@test.com')
    expect(res.body.ingest_token).toMatch(/^[0-9a-f]{48}$/)
    expect(res.body.whatsapp_number).toBeNull()
    expect(res.body.is_admin).toBe(0)
  })

  it('PATCH setea el whatsapp_number', async () => {
    const agent = await authedAgent(app)
    const res = await agent.patch('/api/me').send({ whatsapp_number: '5491100000000' })
    expect(res.status).toBe(200)
    expect(res.body.whatsapp_number).toBe('5491100000000')
    expect((await agent.get('/api/me')).body.whatsapp_number).toBe('5491100000000')
  })

  it('PATCH con un número ya en uso por otro usuario da 409', async () => {
    db.createUser({ email: 'otro@test.com', password: 'x', whatsappNumber: '549111' })
    const agent = await authedAgent(app)
    const res = await agent.patch('/api/me').send({ whatsapp_number: '549111' })
    expect(res.status).toBe(409)
  })
})
