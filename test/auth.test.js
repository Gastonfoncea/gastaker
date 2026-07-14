// test/auth.test.js — auth a nivel db (usuarios/sesiones). Rutas HTTP: ver etapas posteriores.
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db.js'

describe('db: usuarios y sesiones', () => {
  let db
  beforeEach(() => {
    db = createDb(':memory:')
  })

  describe('createUser', () => {
    it('crea un usuario con ingest_token y devuelve sus datos', () => {
      const u = db.createUser({ email: 'gaston@test.com', password: 'clave-larga' })
      expect(u.id).toBeGreaterThan(0)
      expect(u.email).toBe('gaston@test.com')
      expect(u.ingest_token).toMatch(/^[0-9a-f]{48}$/)
      expect(u.whatsapp_number).toBeNull()
      expect(u.is_admin).toBe(0)
    })

    it('marca is_admin cuando isAdmin:true', () => {
      const u = db.createUser({ email: 'admin@test.com', password: 'x', isAdmin: true })
      expect(u.is_admin).toBe(1)
    })

    it('no guarda la password en claro', () => {
      db.createUser({ email: 'a@test.com', password: 'secreto' })
      const row = db.getUserByEmail('a@test.com')
      expect(row.password_hash).not.toContain('secreto')
      expect(row.password_hash.startsWith('scrypt$')).toBe(true)
    })

    it('lanza DUP si el email ya existe (case-insensitive)', () => {
      db.createUser({ email: 'dup@test.com', password: 'x' })
      expect(() => db.createUser({ email: 'DUP@test.com', password: 'y' })).toThrow()
      try {
        db.createUser({ email: 'dup@test.com', password: 'y' })
      } catch (e) {
        expect(e.code).toBe('DUP')
      }
    })

    it('valida email y password requeridos', () => {
      expect(() => db.createUser({ email: '', password: 'x' })).toThrow(/email/)
      expect(() => db.createUser({ email: 'x@test.com', password: '' })).toThrow(/password/)
    })
  })

  describe('authenticate', () => {
    beforeEach(() => db.createUser({ email: 'user@test.com', password: 'mi-clave' }))

    it('devuelve el usuario con credenciales correctas', () => {
      const u = db.authenticate('user@test.com', 'mi-clave')
      expect(u).toBeTruthy()
      expect(u.email).toBe('user@test.com')
    })

    it('es case-insensitive en el email', () => {
      expect(db.authenticate('USER@test.com', 'mi-clave')).toBeTruthy()
    })

    it('devuelve null con password incorrecta', () => {
      expect(db.authenticate('user@test.com', 'mala')).toBeNull()
    })

    it('devuelve null con email inexistente', () => {
      expect(db.authenticate('nadie@test.com', 'mi-clave')).toBeNull()
    })
  })

  describe('getUserBy*', () => {
    let u
    beforeEach(() => {
      u = db.createUser({ email: 'x@test.com', password: 'x', whatsappNumber: '5491122334455' })
    })
    it('getUserById / getUserByEmail / getUserByIngestToken', () => {
      expect(db.getUserById(u.id).email).toBe('x@test.com')
      expect(db.getUserByEmail('x@test.com').id).toBe(u.id)
      expect(db.getUserByIngestToken(u.ingest_token).id).toBe(u.id)
    })
    it('getUserByWhatsappNumber matchea el número pero nunca NULL/vacío', () => {
      expect(db.getUserByWhatsappNumber('5491122334455').id).toBe(u.id)
      expect(db.getUserByWhatsappNumber(null)).toBeUndefined()
      expect(db.getUserByWhatsappNumber('')).toBeUndefined()
      expect(db.getUserByWhatsappNumber('0000')).toBeUndefined()
    })
    it('getUserByIngestToken con token inexistente devuelve undefined', () => {
      expect(db.getUserByIngestToken('nope')).toBeUndefined()
    })
  })

  describe('updateUser', () => {
    it('setea el whatsapp_number', () => {
      const u = db.createUser({ email: 'a@test.com', password: 'x' })
      db.updateUser(u.id, { whatsappNumber: '5491100000000' })
      expect(db.getUserById(u.id).whatsapp_number).toBe('5491100000000')
    })
    it('permite limpiar el número a null', () => {
      const u = db.createUser({ email: 'a@test.com', password: 'x', whatsappNumber: '549110000' })
      db.updateUser(u.id, { whatsappNumber: '' })
      expect(db.getUserById(u.id).whatsapp_number).toBeNull()
    })
    it('lanza DUP si el número ya está en otro usuario', () => {
      db.createUser({ email: 'a@test.com', password: 'x', whatsappNumber: '549111' })
      const b = db.createUser({ email: 'b@test.com', password: 'x' })
      try {
        db.updateUser(b.id, { whatsappNumber: '549111' })
        throw new Error('no tiró')
      } catch (e) {
        expect(e.code).toBe('DUP')
      }
    })
  })

  describe('sesiones', () => {
    let u
    beforeEach(() => {
      u = db.createUser({ email: 'a@test.com', password: 'x' })
    })

    it('createSession devuelve token y expiración; getSession la resuelve', () => {
      const s = db.createSession(u.id)
      expect(s.token).toMatch(/^[0-9a-f]{64}$/)
      const got = db.getSession(s.token)
      expect(got.user_id).toBe(u.id)
    })

    it('getSession de token inexistente/null devuelve null', () => {
      expect(db.getSession('nope')).toBeNull()
      expect(db.getSession(null)).toBeNull()
    })

    it('deleteSession invalida la sesión', () => {
      const s = db.createSession(u.id)
      db.deleteSession(s.token)
      expect(db.getSession(s.token)).toBeNull()
    })

    it('una sesión vencida se considera inválida y se limpia', () => {
      db._raw
        .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('vieja', ?, datetime('now', '-1 day'))")
        .run(u.id)
      expect(db.getSession('vieja')).toBeNull()
      // la limpieza oportunista la borró de la tabla
      expect(db._raw.prepare("SELECT COUNT(*) n FROM sessions WHERE token = 'vieja'").get().n).toBe(0)
    })
  })
})
