// test/whatsapp-number.test.js — el número entrante resuelve al usuario y el agente
// corre sobre SUS datos.
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { whatsappRouter } from '../src/routes/whatsapp.js'
import { createMemory } from '../src/agent/memory.js'
import { createDb } from '../src/db.js'

const SECRET = 'wh-secret'
const sign = (p) => crypto.createHmac('sha256', SECRET).update(JSON.stringify(p)).digest('hex')
const payloadFrom = (from, text) => ({ message: { from, type: 'text', text: { body: text } } })

// runAgent que consulta el resumen del mes vía executeTool y devuelve el total ARS.
// Sirve para verificar CON QUÉ usuario se construyeron las tools.
const echoTotalAgent = vi.fn(async ({ executeTool }) => {
  const r = await executeTool('resumen_mes', { mes: '2026-06' })
  return `total:${r.totalArs}`
})

function makeApp({ send }) {
  const db = createDb(':memory:')
  const A = db.createUser({ email: 'a@test.com', password: 'x', whatsappNumber: '111' })
  const B = db.createUser({ email: 'b@test.com', password: 'x', whatsappNumber: '222' })
  db.forUser(A.id).insert({ gmail_message_id: 'a1', amount: 1500, merchant: 'A', category: 'Comida', occurred_at: '2026-06-01T10:00:00' })
  db.forUser(B.id).insert({ gmail_message_id: 'b1', amount: 999, merchant: 'B', category: 'Comida', occurred_at: '2026-06-01T10:00:00' })
  const app = express()
  app.use(express.json())
  app.use('/api/whatsapp', whatsappRouter({ config: { kapsoWebhookSecret: SECRET, anthropicModel: 'x' }, send, runAgent: echoTotalAgent, memory: createMemory(), db }))
  return app
}

describe('whatsapp scopeado por número', () => {
  it('el número de A corre el agente sobre los datos de A', async () => {
    const send = vi.fn().mockResolvedValue({})
    const app = makeApp({ send })
    const p = payloadFrom('111', '¿cuánto gasté?')
    await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    // Espera a que el trabajo async post-respuesta termine.
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send).toHaveBeenCalledWith('111', 'total:1500')
  })

  it('el número de B ve SUS propios datos, no los de A', async () => {
    const send = vi.fn().mockResolvedValue({})
    const app = makeApp({ send })
    const p = payloadFrom('222', 'hola')
    await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send).toHaveBeenCalledWith('222', 'total:999')
  })

  it('un número desconocido se ignora (sin runAgent, sin send)', async () => {
    const send = vi.fn()
    const runAgent = vi.fn()
    const db = createDb(':memory:')
    db.createUser({ email: 'a@test.com', password: 'x', whatsappNumber: '111' })
    const app = express()
    app.use(express.json())
    app.use('/api/whatsapp', whatsappRouter({ config: { kapsoWebhookSecret: SECRET, anthropicModel: 'x' }, send, runAgent, memory: createMemory(), db }))
    const p = payloadFrom('999', 'hola')
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    expect(res.status).toBe(200)
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
