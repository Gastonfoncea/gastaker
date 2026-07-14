// test/invites.test.js — invites a nivel db y a nivel HTTP (POST /api/invites,
// GET /api/invites/:token, POST /api/register).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { TEST_CONFIG, authedAgent } from './helpers.js'

describe('db: invites', () => {
  let db
  let admin
  beforeEach(() => {
    db = createDb(':memory:')
    admin = db.createUser({ email: 'admin@test.com', password: 'x', isAdmin: true })
  })

  it('createInvite devuelve token y expiración', () => {
    const inv = db.createInvite(admin.id)
    expect(inv.token).toMatch(/^[0-9a-f]{48}$/)
    expect(inv.expires_at).toBeTruthy()
  })

  it('getInvite de un invite fresco es valid:true', () => {
    const inv = db.createInvite(admin.id)
    expect(db.getInvite(inv.token)).toEqual({ valid: true })
  })

  it('getInvite de token inexistente => not_found', () => {
    expect(db.getInvite('nope')).toEqual({ valid: false, reason: 'not_found' })
  })

  it('getInvite de un invite vencido => expired', () => {
    db._raw
      .prepare("INSERT INTO invites (token, created_by, expires_at) VALUES ('viejo', ?, datetime('now','-1 day'))")
      .run(admin.id)
    expect(db.getInvite('viejo')).toEqual({ valid: false, reason: 'expired' })
  })

  it('useInvite lo marca usado; un segundo uso falla y getInvite => used', () => {
    const inv = db.createInvite(admin.id)
    const invitee = db.createUser({ email: 'nuevo@test.com', password: 'x' })
    db.useInvite(inv.token, invitee.id)
    expect(db.getInvite(inv.token)).toEqual({ valid: false, reason: 'used' })
    try {
      db.useInvite(inv.token, invitee.id)
      throw new Error('no tiró')
    } catch (e) {
      expect(e.code).toBe('INVITE_INVALID')
    }
  })

  it('useInvite de un invite vencido falla', () => {
    db._raw
      .prepare("INSERT INTO invites (token, created_by, expires_at) VALUES ('viejo', ?, datetime('now','-1 day'))")
      .run(admin.id)
    const invitee = db.createUser({ email: 'nuevo@test.com', password: 'x' })
    expect(() => db.useInvite('viejo', invitee.id)).toThrow()
  })
})

describe('HTTP: invites y register', () => {
  let db, app
  beforeEach(() => {
    db = createDb(':memory:')
    db.createUser({ email: 'admin@test.com', password: 'clave-admin', isAdmin: true })
    app = createApp({ db, config: TEST_CONFIG })
  })

  async function newInvite() {
    const admin = await authedAgent(app, { email: 'admin@test.com', password: 'clave-admin' })
    const res = await admin.post('/api/invites')
    return res.body // { token, url, expires_at }
  }

  it('POST /api/invites sin auth da 401', async () => {
    expect((await request(app).post('/api/invites')).status).toBe(401)
  })

  it('POST /api/invites de un usuario no-admin da 403', async () => {
    // Alta de un usuario invitado (no admin) y login.
    const inv = await newInvite()
    await request(app).post('/api/register').send({ token: inv.token, email: 'pepe@test.com', password: 'clave-pepe' })
    const pepe = await authedAgent(app, { email: 'pepe@test.com', password: 'clave-pepe' })
    expect((await pepe.post('/api/invites')).status).toBe(403)
  })

  it('POST /api/invites de admin devuelve token, url y expires_at', async () => {
    const inv = await newInvite()
    expect(inv.token).toMatch(/^[0-9a-f]{48}$/)
    expect(inv.url).toContain(`/registro.html?token=${inv.token}`)
    expect(inv.expires_at).toBeTruthy()
  })

  it('GET /api/invites/:token es público y valida', async () => {
    const inv = await newInvite()
    expect((await request(app).get(`/api/invites/${inv.token}`)).body).toEqual({ valid: true })
    expect((await request(app).get('/api/invites/no-existe')).body).toEqual({ valid: false, reason: 'not_found' })
  })

  it('register exitoso: 201, cookie, 9 categorías, ingest_token, y auto-login', async () => {
    const inv = await newInvite()
    const agent = request.agent(app)
    const res = await agent.post('/api/register').send({ token: inv.token, email: 'nuevo@test.com', password: 'clave-nueva' })
    expect(res.status).toBe(201)
    expect(res.headers['set-cookie'].join()).toContain('gastaker_auth')
    // Auto-login: la cookie ya sirve para endpoints protegidos.
    expect((await agent.get('/api/me')).status).toBe(200)
    // Seed de 8 categorías + ingest_token.
    const me = (await agent.get('/api/me')).body
    expect(me.ingest_token).toMatch(/^[0-9a-f]{48}$/)
    expect((await agent.get('/api/categories')).body.categories).toHaveLength(9)
  })

  it('register consume el invite: un segundo register con el mismo token da 410', async () => {
    const inv = await newInvite()
    await request(app).post('/api/register').send({ token: inv.token, email: 'a@test.com', password: 'x' })
    const res = await request(app).post('/api/register').send({ token: inv.token, email: 'b@test.com', password: 'x' })
    expect(res.status).toBe(410)
  })

  it('register con token inexistente o ausente da 410', async () => {
    expect((await request(app).post('/api/register').send({ token: 'nope', email: 'a@test.com', password: 'x' })).status).toBe(410)
    expect((await request(app).post('/api/register').send({ email: 'a@test.com', password: 'x' })).status).toBe(410)
  })

  it('register con invite vencido da 410', async () => {
    const admin = db.getUserByEmail('admin@test.com')
    db._raw.prepare("INSERT INTO invites (token, created_by, expires_at) VALUES ('viejo', ?, datetime('now','-1 day'))").run(admin.id)
    const res = await request(app).post('/api/register').send({ token: 'viejo', email: 'a@test.com', password: 'x' })
    expect(res.status).toBe(410)
  })

  it('register sin email o password da 400', async () => {
    const inv = await newInvite()
    expect((await request(app).post('/api/register').send({ token: inv.token, email: 'a@test.com' })).status).toBe(400)
  })

  it('register con email ya usado da 409 (y no consume el invite)', async () => {
    const inv = await newInvite()
    const res = await request(app).post('/api/register').send({ token: inv.token, email: 'admin@test.com', password: 'x' })
    expect(res.status).toBe(409)
  })
})
