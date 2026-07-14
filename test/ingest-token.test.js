// test/ingest-token.test.js — la ingesta se scopea al usuario del ingest_token.
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { TEST_CONFIG } from './helpers.js'

const SAMPLE = `Monto
$1.000,00
Comercio
VERDULERIA KATIE
Fecha
08/06/2026
Hora
19:12`

describe('ingesta scopeada por ingest_token', () => {
  let db, app, A, B
  beforeEach(() => {
    db = createDb(':memory:')
    A = db.createUser({ email: 'a@test.com', password: 'x' })
    B = db.createUser({ email: 'b@test.com', password: 'x' })
    app = createApp({ db, config: TEST_CONFIG })
  })

  it('un gasto ingresado con el token de A solo lo ve A', async () => {
    const res = await request(app).post('/api/ingest').set('X-Webhook-Secret', A.ingest_token).send({ messageId: 'm1', body: SAMPLE })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(db.forUser(A.id).list('2026-06')).toHaveLength(1)
    expect(db.forUser(B.id).list('2026-06')).toHaveLength(0)
  })

  it('token inexistente => 401 y no inserta nada', async () => {
    const res = await request(app).post('/api/ingest').set('X-Webhook-Secret', 'no-existe').send({ messageId: 'm1', body: SAMPLE })
    expect(res.status).toBe(401)
    expect(db.forUser(A.id).list('2026-06')).toHaveLength(0)
  })
})
