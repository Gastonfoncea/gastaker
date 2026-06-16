// src/routes/ingest.js
import express from 'express'
import { parseEmail } from '../sources/index.js'
import { categorize } from '../categorizer.js'
import { avisarSinClasificar } from '../agent/notifier.js'

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

    const parsed = parseEmail({ body, subject: req.body?.subject })
    if (!parsed) {
      return res.json({ skipped: true })
    }

    // Categoría: transferencia fija; si no, regla estática -> comercio aprendido -> default.
    let category
    let needsReview = 0
    if (parsed.kind === 'transferencia') {
      const learned = db.findLearned(parsed.merchant)
      category = learned || 'Transferencias'
      needsReview = learned ? 0 : 1
    } else {
      const byRule = categorize(parsed.merchant) // 'Otros' si no matchea
      if (byRule !== 'Otros') {
        category = byRule
      } else {
        const learned = db.findLearned(parsed.merchant)
        category = learned || 'Otros'
        needsReview = learned ? 0 : 1
      }
    }

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
      source: parsed.source,
      needs_review: needsReview,
    })

    if (inserted && needsReview && config.pushEnabled) {
      // No bloquea la respuesta del webhook (no se hace await).
      avisarSinClasificar(
        { merchant: parsed.merchant, amount: parsed.amount, currency: parsed.currency },
        { enabled: true, to: config.notifyWhatsapp }
      )
    }

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
