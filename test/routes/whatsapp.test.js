// test/routes/whatsapp.test.js
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { whatsappRouter } from '../../src/routes/whatsapp.js'
import { createMemory } from '../../src/agent/memory.js'
import { createDb } from '../../src/db.js'

const SECRET = 'wh-secret'
const sign = (p) => crypto.createHmac('sha256', SECRET).update(JSON.stringify(p)).digest('hex')

// Monta el router con una db real; el número autorizado es el whatsapp_number del user.
function makeAppAgent({ send, runAgent, authorizedNumber }) {
  const db = createDb(':memory:')
  if (authorizedNumber) db.createUser({ email: 'u@test.com', password: 'x', whatsappNumber: authorizedNumber })
  const app = express()
  app.use(express.json())
  app.use(
    '/api/whatsapp',
    whatsappRouter({
      config: { kapsoWebhookSecret: SECRET, anthropicModel: 'claude-haiku-4-5' },
      send,
      runAgent,
      memory: createMemory(),
      db,
    })
  )
  return app
}

const payload = { message: { from: '5493513071645', type: 'text', text: { body: 'hola bot' } } }

describe('POST /api/whatsapp', () => {
  it('con firma inválida: 401 y no contesta', async () => {
    const send = vi.fn()
    const app = makeAppAgent({ send, runAgent: vi.fn(), authorizedNumber: '5493513071645' })
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', 'firma-mala').send(payload)
    expect(res.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('mensaje sin texto: 200 y no contesta', async () => {
    const send = vi.fn()
    const app = makeAppAgent({ send, runAgent: vi.fn(), authorizedNumber: '549' })
    const noText = { message: { from: '549', type: 'image' } }
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(noText)).send(noText)
    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })
})

function payloadFrom(from, text) {
  return { message: { from, type: 'text', text: { body: text } } }
}

describe('agente en /api/whatsapp', () => {
  it('ignora (200, sin responder) si el número no matchea ningún usuario', async () => {
    const send = vi.fn()
    const runAgent = vi.fn(async () => 'no debería')
    const app = makeAppAgent({ send, runAgent, authorizedNumber: '549111' })
    const p = payloadFrom('549999', 'hola')
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    expect(res.status).toBe(200)
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('del número de un usuario: corre el agente y responde por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    const runAgent = vi.fn(async () => 'Gastaste $1500 en junio.')
    const app = makeAppAgent({ send, runAgent, authorizedNumber: '549111' })
    const p = payloadFrom('549111', '¿cuánto gasté?')
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    expect(res.status).toBe(200)
    expect(runAgent).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('549111', 'Gastaste $1500 en junio.')
  })
})
