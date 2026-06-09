// src/app.js
import express from 'express'
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ingestRouter } from './routes/ingest.js'
import { loginHandler } from './auth.js'
import { expensesRouter } from './routes/expenses.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// createApp({ db, config }) arma el Express y devuelve la app SIN levantarla.
// Se le inyecta db y config para poder testear con una DB en memoria.
export function createApp({ db, config }) {
  const app = express()
  // Detrás de Caddy (reverse proxy): confiar en X-Forwarded-Proto para que
  // req.secure refleje si la conexión real del visitante es HTTPS.
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.use('/api/ingest', ingestRouter({ db, config }))
  app.post('/api/login', loginHandler({ config }))
  app.use('/api/expenses', expensesRouter({ db, config }))

  // Sirve el frontend estático (HTML/CSS/JS no contienen datos sensibles).
  app.use(express.static(join(__dirname, '..', 'public')))

  return app
}
