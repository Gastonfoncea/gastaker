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
