// test/routes/whatsapp.test.js
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { whatsappRouter } from '../../src/routes/whatsapp.js'

const SECRET = 'wh-secret'
const sign = (p) => crypto.createHmac('sha256', SECRET).update(JSON.stringify(p)).digest('hex')

function makeApp(send) {
  const app = express()
  app.use(express.json())
  app.use('/api/whatsapp', whatsappRouter({ config: { kapsoWebhookSecret: SECRET }, send }))
  return app
}

const payload = {
  message: { from: '5493513071645', type: 'text', text: { body: 'hola bot' } },
}

describe('POST /api/whatsapp', () => {
  it('con firma válida: responde 200 y contesta por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', sign(payload))
      .send(payload)
    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledWith('5493513071645', 'Recibí: hola bot')
  })

  it('con firma inválida: 401 y no contesta', async () => {
    const send = vi.fn()
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', 'firma-mala')
      .send(payload)
    expect(res.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('mensaje sin texto: 200 y no contesta', async () => {
    const send = vi.fn()
    const noText = { message: { from: '549', type: 'image' } }
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', sign(noText))
      .send(noText)
    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })
})
