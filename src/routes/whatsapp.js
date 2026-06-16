// src/routes/whatsapp.js
import express from 'express'
import { verifyKapsoSignature, sendWhatsApp } from '../whatsapp.js'
import { runAgent as realRunAgent, systemPrompt } from '../agent/agent.js'
import { buildTools } from '../agent/tools.js'

// Router del webhook entrante. Dependencias inyectables para testear sin red.
export function whatsappRouter({ config, send = sendWhatsApp, runAgent = realRunAgent, memory, db }) {
  const router = express.Router()

  router.post('/', async (req, res) => {
    const signature = req.get('X-Webhook-Signature')
    if (!verifyKapsoSignature(req.body, signature, config.kapsoWebhookSecret)) {
      return res.status(401).json({ error: 'firma inválida' })
    }
    // Responder rápido siempre (Kapso exige < 10s); el trabajo va después.
    res.json({ ok: true })

    const msg = req.body?.message
    const from = msg?.from
    const text = msg?.text?.body
    if (!from || !text) return
    // Solo el número autorizado (son finanzas personales).
    if (from !== config.allowedNumber) return

    try {
      const history = memory.load(from)
      const messages = [...history, { role: 'user', content: text }]
      const tools = buildTools(db)
      const today = new Date().toISOString().slice(0, 10)
      const reply = await runAgent({
        model: config.anthropicModel,
        system: systemPrompt(today),
        tools: tools.definitions,
        executeTool: tools.execute,
        messages,
      })
      memory.save(from, [...messages, { role: 'assistant', content: reply }])
      await send(from, reply)
    } catch (e) {
      console.error('agente falló:', e.message)
      try {
        await send(from, 'Ups, no pude procesar eso ahora, probá de nuevo.')
      } catch {}
    }
  })

  return router
}
