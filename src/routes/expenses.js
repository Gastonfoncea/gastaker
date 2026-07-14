// src/routes/expenses.js
import express from 'express'
import { requireAuth } from '../auth.js'

export function expensesRouter({ db }) {
  const router = express.Router()
  router.use(requireAuth({ db }))

  // GET /api/expenses?month=YYYY-MM  -> { expenses: [...], totals: {cat: monto} }
  router.get('/', (req, res) => {
    const udb = db.forUser(req.userId)
    const month = req.query.month || defaultMonth()
    const expenses = udb.list(month)
    const totals = {}
    for (const e of expenses) {
      totals[e.category] = (totals[e.category] || 0) + e.amount
    }
    res.json({ month, expenses, totals })
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
