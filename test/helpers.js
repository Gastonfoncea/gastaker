// test/helpers.js — helpers compartidos para los tests multi-user.
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'

// Config mínima que necesita createApp tras el refactor multi-user.
export const TEST_CONFIG = { kapsoWebhookSecret: 'wh-secret', anthropicModel: 'claude-haiku-4-5' }

// Crea una db en memoria con un usuario y devuelve { db, user, udb }.
export function makeUserDb({ email = 'test@test.com', password = 'clave-test', isAdmin = false, whatsappNumber = null } = {}) {
  const db = createDb(':memory:')
  const user = db.createUser({ email, password, isAdmin, whatsappNumber })
  return { db, user, udb: db.forUser(user.id) }
}

// Crea db + user + app y devuelve { db, user, app }.
export function makeAppWithUser(opts = {}) {
  const { db, user } = makeUserDb(opts)
  const app = createApp({ db, config: TEST_CONFIG })
  return { db, user, app }
}

// Devuelve un supertest agent ya logueado por email+password.
export async function authedAgent(app, { email = 'test@test.com', password = 'clave-test' } = {}) {
  const agent = request.agent(app)
  await agent.post('/api/login').send({ email, password })
  return agent
}
