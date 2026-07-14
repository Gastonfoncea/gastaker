// src/auth.js

// Config de la cookie de sesión. httpOnly + sameSite lax. secure según req.secure:
// en producción (detrás de Caddy) req.secure es true → la cookie nunca viaja en
// claro; en tests/local (http) es false.
function cookieOpts(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
  }
}

// Handler de login por email+password. Crea una sesión real y setea la cookie.
export function loginHandler({ db }) {
  return (req, res) => {
    const { email, password } = req.body || {}
    const user = db.authenticate(email, password)
    if (!user) return res.status(401).json({ error: 'email o clave incorrectos' })
    const { token } = db.createSession(user.id)
    res.cookie('gastaker_auth', token, cookieOpts(req))
    return res.json({ ok: true })
  }
}

// Handler de logout: borra la sesión de la db y limpia la cookie.
export function logoutHandler({ db }) {
  return (req, res) => {
    const token = req.cookies?.gastaker_auth
    if (token) db.deleteSession(token)
    res.clearCookie('gastaker_auth')
    return res.json({ ok: true })
  }
}

// Middleware que exige una sesión válida. Setea req.userId.
export function requireAuth({ db }) {
  return (req, res, next) => {
    const token = req.cookies?.gastaker_auth
    const session = token ? db.getSession(token) : null
    if (!session) return res.status(401).json({ error: 'no autorizado' })
    req.userId = session.user_id
    return next()
  }
}

// Middleware que exige que el usuario sea admin. Corre DESPUÉS de requireAuth.
export function requireAdmin({ db }) {
  return (req, res, next) => {
    const user = db.getUserById(req.userId)
    if (!user || user.is_admin !== 1) return res.status(403).json({ error: 'requiere admin' })
    return next()
  }
}
