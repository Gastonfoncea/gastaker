// src/routes/invites.js — invitaciones (solo admin) y registro con invite.
import express from 'express'
import { requireAuth, requireAdmin, setAuthCookie } from '../auth.js'

export function invitesRouter({ db }) {
  const router = express.Router()

  // POST /api/invites -> genera un link de un solo uso. Solo admin.
  router.post('/', requireAuth({ db }), requireAdmin({ db }), (req, res) => {
    const inv = db.createInvite(req.userId)
    const url = `${req.protocol}://${req.get('host')}/registro.html?token=${inv.token}`
    res.status(201).json({ token: inv.token, url, expires_at: inv.expires_at })
  })

  // GET /api/invites/:token -> { valid:true } | { valid:false, reason }. Público:
  // la página de registro necesita saber si el token sirve antes de mostrar el form.
  router.get('/:token', (req, res) => {
    res.json(db.getInvite(req.params.token))
  })

  return router
}

// Handler de registro con invite (POST /api/register). Público. En éxito auto-loguea.
export function registerHandler({ db }) {
  return (req, res) => {
    const { token, email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ error: 'faltan email o password' })

    const check = db.getInvite(token)
    if (!check.valid) return res.status(410).json({ error: `invitación ${check.reason}` })

    let user
    try {
      user = db.createUser({ email, password, isAdmin: false })
    } catch (e) {
      if (e.code === 'DUP') return res.status(409).json({ error: e.message })
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message })
      throw e
    }

    try {
      db.useInvite(token, user.id)
    } catch (e) {
      // Carrera: el invite se consumió entre el check y ahora.
      return res.status(410).json({ error: 'invitación inválida' })
    }

    const { token: sessionToken } = db.createSession(user.id)
    setAuthCookie(req, res, sessionToken)
    res.status(201).json({ ok: true })
  }
}
