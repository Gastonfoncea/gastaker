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

  it('guarda un consumo en dólares con su moneda', async () => {
    const usd = `MontoU$S6,33
ComercioMicrosoft*Xbox Game Pass
Fecha04/06/2026
Hora00:43`
    const res = await request(app)
      .post('/api/ingest')
      .set('X-Webhook-Secret', 'secreto-test')
      .send({ messageId: 'usd1', body: usd })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(res.body.currency).toBe('USD')
    expect(res.body.category).toBe('Suscripciones')
  })

  it('categoriza transferencias como Transferencias y usa receivedAt si no hay fecha', async () => {
    const transfer = `Destinatario    20520522523
    CBU de Destino    0000003100090368368647
    Importe    $ 1.000,00
    Número de comprobante    61949218`
    const res = await request(app)
      .post('/api/ingest')
      .set('X-Webhook-Secret', 'secreto-test')
      .send({ messageId: 'tr1', body: transfer, receivedAt: '2026-06-02T15:10:00.000Z' })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(res.body.category).toBe('Transferencias')
    expect(res.body.currency).toBe('ARS')
  })

  it('un comercio desconocido entra con needs_review; tras registrarlo, el siguiente no', async () => {
    const db = createDb(':memory:')
    const app = createApp({ db, config: CONFIG })
    const body = `Aviso de consumo TD
Tarjeta Santander Visa Débito terminada en *1458*.
Monto
*$5.000,00*
Comercio
*KIOSCO RARO*
Fecha
*08/06/2026*
Hora
*10:00*`
    await request(app).post('/api/ingest').set('X-Webhook-Secret', 'secreto-test').send({ messageId: 'k1', body })
    expect(db.pendientes()).toHaveLength(1) // cayó en Otros -> pendiente

    db.registrarComercio({ match: 'KIOSCO RARO', categoria: 'Comida' })
    await request(app).post('/api/ingest').set('X-Webhook-Secret', 'secreto-test').send({ messageId: 'k2', body: body.replace('10:00', '11:00') })
    // el segundo NO queda pendiente (lo agarró findLearned)
    const last = db.list('2026-06').find((e) => e.gmail_message_id === 'k2')
    expect(last.category).toBe('Comida')
    expect(last.needs_review).toBe(0)
  })
})
