// src/auth.js

// Handler de login: si la password coincide, setea una cookie httpOnly
// con el sessionToken. Montar en POST /api/login.
export function loginHandler({ config }) {
  return (req, res) => {
    const { password } = req.body || {}
    if (!password || password !== config.appPassword) {
      return res.status(401).json({ error: 'clave incorrecta' })
    }
    res.cookie('gastaker_auth', config.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      // Solo se manda por HTTPS. En producción (detrás de Caddy) req.secure es
      // true → la cookie nunca viaja en claro. En tests/local (http) es false.
      secure: req.secure,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    })
    return res.json({ ok: true })
  }
}

// Middleware que exige la cookie de sesión válida.
export function requireAuth({ config }) {
  return (req, res, next) => {
    if (req.cookies?.gastaker_auth === config.sessionToken) return next()
    return res.status(401).json({ error: 'no autorizado' })
  }
}
