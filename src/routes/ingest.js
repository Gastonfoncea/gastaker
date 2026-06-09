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

    const { messageId, body, receivedAt } = req.body || {}
    if (!messageId || !body) {
      return res.status(400).json({ error: 'faltan messageId o body' })
    }

    const parsed = parseExpenseEmail(body)
    if (!parsed) {
      return res.json({ skipped: true })
    }

    // Las transferencias no tienen comercio: categoría fija (recategorizable).
    const category =
      parsed.kind === 'transferencia' ? 'Transferencias' : categorize(parsed.merchant)

    // Si el mail no trae Fecha/Hora (típico en transferencias), usamos la fecha
    // en que llegó el mail.
    const occurred_at =
      parsed.occurredAt || normalizeReceived(receivedAt) || new Date().toISOString().slice(0, 19)

    const { inserted } = db.insert({
      gmail_message_id: messageId,
      amount: parsed.amount,
      merchant: parsed.merchant,
      category,
      card: parsed.card,
      occurred_at,
      currency: parsed.currency,
    })

    return res.json({ inserted, category, currency: parsed.currency })
  })

  return router
}

// "2026-06-04T03:43:00.000Z" -> "2026-06-04T03:43:00" (o null si no aplica)
function normalizeReceived(r) {
  if (!r || typeof r !== 'string') return null
  const m = r.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : null
}
