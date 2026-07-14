// src/routes/me.js — datos de la cuenta del usuario logueado.
import express from 'express'
import { requireAuth } from '../auth.js'

export function meRouter({ db }) {
  const router = express.Router()
  router.use(requireAuth({ db }))

  // GET /api/me -> { email, ingest_token, whatsapp_number, is_admin }
  router.get('/', (req, res) => {
    const u = db.getUserById(req.userId)
    res.json({ email: u.email, ingest_token: u.ingest_token, whatsapp_number: u.whatsapp_number, is_admin: u.is_admin })
  })

  // PATCH /api/me { whatsapp_number } -> setea/limpia el número
  router.patch('/', (req, res) => {
    const { whatsapp_number } = req.body || {}
    try {
      const r = db.updateUser(req.userId, { whatsappNumber: whatsapp_number })
      res.json({ ok: true, whatsapp_number: r.whatsapp_number })
    } catch (e) {
      if (e.code === 'DUP') return res.status(409).json({ error: e.message })
      return res.status(400).json({ error: e.message })
    }
  })

  return router
}
