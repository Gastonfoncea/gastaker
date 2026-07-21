// src/routes/expenses.js
import express from 'express'
import { requireAuth } from '../auth.js'
import { randomToken } from '../crypto.js'

export function expensesRouter({ db }) {
  const router = express.Router()
  router.use(requireAuth({ db }))

  // GET /api/expenses?month=YYYY-MM  -> { expenses: [...], totals: {cat: monto} }
  router.get('/', (req, res) => {
    const udb = db.forUser(req.userId)
    const month = req.query.month || defaultMonth()
    const expenses = udb.list(month)
    // Las categorías con excluded=1 y los consumos con crédito se ven en la
    // lista pero no suman al total (el crédito se debita el mes siguiente).
    const excluded = new Set(udb.listCategories().filter((c) => c.excluded).map((c) => c.name))
    const totals = {}
    for (const e of expenses) {
      if (excluded.has(e.category) || e.payment_method === 'Crédito') continue
      totals[e.category] = (totals[e.category] || 0) + e.amount
    }
    res.json({ month, expenses, totals })
  })

  // POST /api/expenses  { amount, merchant, category } -> 201 { expense }
  // Alta manual: source='manual', fecha=ahora, ARS, cuenta como débito
  // (payment_method NULL). El gmail_message_id sintético satisface el UNIQUE.
  router.post('/', (req, res) => {
    const udb = db.forUser(req.userId)
    const { amount, merchant, category } = req.body || {}
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'monto inválido' })
    }
    const m = (merchant || '').trim()
    if (!m) return res.status(400).json({ error: 'falta el comercio' })
    const wanted = String(category || '').trim().toLowerCase()
    const cat = udb.listCategories().find((c) => c.name.toLowerCase() === wanted)
    if (!cat) return res.status(400).json({ error: `no existe la categoría "${category}"` })

    const { id } = udb.insert({
      gmail_message_id: `manual-${randomToken(12)}`,
      amount,
      merchant: m,
      category: cat.name,
      occurred_at: new Date().toISOString().slice(0, 19),
      source: 'manual',
    })
    res.status(201).json({ expense: udb.getExpense(id) })
  })

  // DELETE /api/expenses/:id — solo gastos manuales; los del mail son historial
  // del banco y no se tocan.
  router.delete('/:id', (req, res) => {
    const udb = db.forUser(req.userId)
    const id = Number.parseInt(req.params.id, 10)
    const expense = udb.getExpense(id)
    if (!expense) return res.status(404).json({ error: 'no encontrado' })
    if (expense.source !== 'manual') {
      return res.status(400).json({ error: 'solo se pueden borrar gastos manuales' })
    }
    udb.deleteExpense(id)
    res.json({ ok: true })
  })

  // PATCH /api/expenses/:id  { category, learn? }
  // learn: además de clasificar este gasto, aprende "merchant -> category"
  // y re-clasifica todos los gastos de ese comercio (histórico incluido).
  router.patch('/:id', (req, res) => {
    const udb = db.forUser(req.userId)
    const id = Number.parseInt(req.params.id, 10)
    const { category, learn } = req.body || {}
    if (!category) return res.status(400).json({ error: 'falta category' })
    const expense = udb.getExpense(id)
    if (!expense) return res.status(404).json({ error: 'no encontrado' })

    if (learn) {
      // registrarComercio valida el match (blacklist / largo mínimo) y ya
      // re-clasifica este mismo gasto, porque su merchant se contiene a sí mismo.
      try {
        const r = udb.registrarComercio({ match: expense.merchant, categoria: category })
        return res.json({ ok: true, actualizados: r.actualizados })
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
    }

    udb.clasificarGasto(id, category)
    res.json({ ok: true, actualizados: 1 })
  })

  return router
}

function defaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
