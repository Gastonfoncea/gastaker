// src/server.js
import { createApp } from './app.js'
import { createDb } from './db.js'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Falta la variable de entorno ${name}. Mirá .env.example`)
    process.exit(1)
  }
  return v
}

const config = {
  kapsoWebhookSecret: requireEnv('KAPSO_WEBHOOK_SECRET'),
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
}

const dbPath = process.env.DB_PATH || './gastaker.db'
const port = Number.parseInt(process.env.PORT || '3000', 10)

const db = createDb(dbPath)
const app = createApp({ db, config })

// Escucha solo en localhost: queda invisible desde internet; Caddy le habla por dentro.
app.listen(port, '127.0.0.1', () => {
  console.log(`Gastaker escuchando en http://127.0.0.1:${port}`)
})
