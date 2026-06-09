// src/routes/expenses.js
import express from 'express'
import { requireAuth } from '../auth.js'

export function expensesRouter({ db, config }) {
  const router = express.Router()
  router.use(requireAuth({ config }))

  // GET /api/expenses?month=YYYY-MM  -> { expenses: [...], totals: {cat: monto} }
  router.get('/', (req, res) => {
    const month = req.query.month || defaultMonth()
    const expenses = db.list(month)
    const totals = {}
    for (const e of expenses) {
      totals[e.category] = (totals[e.category] || 0) + e.amount
    }
    res.json({ month, expenses, totals })
  })

  // PATCH /api/expenses/:id  { category }
  router.patch('/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10)
    const { category } = req.body || {}
    if (!category) return res.status(400).json({ error: 'falta category' })
    const ok = db.updateCategory(id, category)
    if (!ok) return res.status(404).json({ error: 'no encontrado' })
    res.json({ ok: true })
  })

  return router
}

function defaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
