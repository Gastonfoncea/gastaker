// src/routes/ingest.js
import express from 'express'
import { parseEmail } from '../sources/index.js'
import { categorize } from '../categorizer.js'

// Crea el router de ingesta. El header X-Webhook-Secret trae el ingest_token del
// usuario, que resuelve a qué cuenta pertenece el gasto.
export function ingestRouter({ db }) {
  const router = express.Router()

  router.post('/', (req, res) => {
    const user = db.getUserByIngestToken(req.get('X-Webhook-Secret'))
    if (!user) {
      return res.status(401).json({ error: 'token inválido' })
    }
    const udb = db.forUser(user.id)

    const { messageId, body, receivedAt } = req.body || {}
    if (!messageId || !body) {
      return res.status(400).json({ error: 'faltan messageId o body' })
    }

    const parsed = parseEmail({ body, subject: req.body?.subject })
    if (!parsed) {
      return res.json({ skipped: true })
    }

    // Categoría: transferencia fija; si no, regla estática -> comercio aprendido -> default.
    let category
    let needsReview = 0
    if (parsed.kind === 'transferencia') {
      const learned = udb.findLearned(parsed.merchant)
      category = learned || 'Transferencias'
      needsReview = learned ? 0 : 1
    } else {
      const byRule = categorize(parsed.merchant) // 'Otros' si no matchea
      if (byRule !== 'Otros') {
        category = byRule
      } else {
        const learned = udb.findLearned(parsed.merchant)
        category = learned || 'Otros'
        needsReview = learned ? 0 : 1
      }
    }

    // Si el mail no trae Fecha/Hora (típico en transferencias), usamos la fecha
    // en que llegó el mail.
    const occurred_at =
      parsed.occurredAt || normalizeReceived(receivedAt) || new Date().toISOString().slice(0, 19)

    const { inserted } = udb.insert({
      gmail_message_id: messageId,
      amount: parsed.amount,
      merchant: parsed.merchant,
      category,
      card: parsed.card,
      payment_method: parsed.type || null,
      occurred_at,
      currency: parsed.currency,
      source: parsed.source,
      needs_review: needsReview,
    })

    return res.json({ inserted, category, currency: parsed.currency, source: parsed.source })
  })

  return router
}

// "2026-06-04T03:43:00.000Z" -> "2026-06-04T03:43:00" (o null si no aplica)
function normalizeReceived(r) {
  if (!r || typeof r !== 'string') return null
  const m = r.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : null
}
