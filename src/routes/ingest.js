// src/routes/ingest.js
import express from 'express'
import { parseExpenseEmail } from '../parser.js'
import { categorize } from '../categorizer.js'

// Crea el router de ingesta. Valida el secreto del webhook contra config.
export function ingestRouter({ db, config }) {
  const router = express.Router()

  router.post('/', (req, res) => {
    const secret = req.get('X-Webhook-Secret')
    if (!secret || secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'secreto inválido' })
    }

    const { messageId, body } = req.body || {}
    if (!messageId || !body) {
      return res.status(400).json({ error: 'faltan messageId o body' })
    }

    const parsed = parseExpenseEmail(body)
    if (!parsed) {
      return res.json({ skipped: true })
    }

    const category = categorize(parsed.merchant)
    const { inserted } = db.insert({
      gmail_message_id: messageId,
      amount: parsed.amount,
      merchant: parsed.merchant,
      category,
      card: parsed.card,
      occurred_at: parsed.occurredAt,
    })

    return res.json({ inserted, category })
  })

  return router
}
