// test/invites.test.js — invites a nivel db. Las rutas HTTP (POST /api/invites,
// /api/register) se agregan y testean en etapas posteriores.
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db.js'

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
