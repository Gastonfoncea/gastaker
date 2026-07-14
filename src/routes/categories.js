// src/routes/categories.js
import express from 'express'
import { requireAuth } from '../auth.js'

// Mapea los códigos de error de la db a status HTTP.
const STATUS = { VALIDATION: 400, PROTECTED: 400, NOT_FOUND: 404, DUP: 409 }
const fail = (res, e) => res.status(STATUS[e.code] || 500).json({ error: e.message })

export function categoriesRouter({ db }) {
  const router = express.Router()
  router.use(requireAuth({ db }))

  // GET /api/categories -> { categories: [{ id, name, color, count }] }
  router.get('/', (req, res) => {
    res.json({ categories: db.forUser(req.userId).listCategories() })
  })

  // POST /api/categories { name, color }
  router.post('/', (req, res) => {
    try {
      res.status(201).json(db.forUser(req.userId).createCategory(req.body || {}))
    } catch (e) {
      fail(res, e)
    }
  })

  // PATCH /api/categories/:id { name?, color? }
  router.patch('/:id', (req, res) => {
    try {
      res.json(db.forUser(req.userId).updateCategoryDef(Number.parseInt(req.params.id, 10), req.body || {}))
    } catch (e) {
      fail(res, e)
    }
  })

  // DELETE /api/categories/:id -> los gastos pasan a "Otros"
  router.delete('/:id', (req, res) => {
    try {
      const r = db.forUser(req.userId).deleteCategory(Number.parseInt(req.params.id, 10))
      res.json({ ok: true, movidos: r.movidos })
    } catch (e) {
      fail(res, e)
    }
  })

  return router
}
