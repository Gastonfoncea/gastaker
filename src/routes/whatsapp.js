// src/routes/whatsapp.js
import express from 'express'
import { verifyKapsoSignature, sendWhatsApp } from '../whatsapp.js'

// Router del webhook entrante de Kapso. `send` se inyecta para testear sin red.
export function whatsappRouter({ config, send = sendWhatsApp }) {
  const router = express.Router()

  router.post('/', async (req, res) => {
    const signature = req.get('X-Webhook-Signature')
    if (!verifyKapsoSignature(req.body, signature, config.kapsoWebhookSecret)) {
      return res.status(401).json({ error: 'firma inválida' })
    }

    const msg = req.body?.message
    const from = msg?.from
    const text = msg?.text?.body

    // Hito de prueba: eco. (Más adelante acá va el agente.)
    if (from && text) {
      try {
        await send(from, `Recibí: ${text}`)
      } catch (e) {
        console.error('No pude responder por WhatsApp:', e.message)
      }
    }

    return res.json({ ok: true })
  })

  return router
}
