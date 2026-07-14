// test/crypto.test.js
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, randomToken } from '../src/crypto.js'

describe('crypto', () => {
  describe('hashPassword / verifyPassword', () => {
    it('produce un string con formato scrypt$salt$hash', () => {
      const stored = hashPassword('clave-larga-secreta')
      const parts = stored.split('$')
      expect(parts).toHaveLength(3)
      expect(parts[0]).toBe('scrypt')
      expect(parts[1]).toMatch(/^[0-9a-f]{32}$/) // salt 16 bytes
      expect(parts[2]).toMatch(/^[0-9a-f]{128}$/) // hash 64 bytes
    })

    it('verifica correctamente la password original', () => {
      const stored = hashPassword('mi-password')
      expect(verifyPassword('mi-password', stored)).toBe(true)
    })

    it('rechaza una password incorrecta', () => {
      const stored = hashPassword('mi-password')
      expect(verifyPassword('otra-cosa', stored)).toBe(false)
    })

    it('usa un salt distinto por hash (dos hashes de la misma clave difieren)', () => {
      const a = hashPassword('igual')
      const b = hashPassword('igual')
      expect(a).not.toBe(b)
      expect(verifyPassword('igual', a)).toBe(true)
      expect(verifyPassword('igual', b)).toBe(true)
    })

    it('devuelve false ante stored malformado sin tirar excepción', () => {
      expect(verifyPassword('x', 'no-es-formato')).toBe(false)
      expect(verifyPassword('x', 'scrypt$solodos')).toBe(false)
      expect(verifyPassword('x', 'bcrypt$aa$bb')).toBe(false)
      expect(verifyPassword('x', '')).toBe(false)
      expect(verifyPassword('x', null)).toBe(false)
      expect(verifyPassword('x', undefined)).toBe(false)
    })

    it('devuelve false si el salt o el hash están vacíos', () => {
      expect(verifyPassword('x', 'scrypt$$abcd')).toBe(false)
      expect(verifyPassword('x', 'scrypt$abcd$')).toBe(false)
    })
  })

  describe('randomToken', () => {
    it('devuelve hex del largo esperado (bytes*2)', () => {
      expect(randomToken()).toMatch(/^[0-9a-f]{48}$/) // default 24 bytes
      expect(randomToken(32)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('devuelve tokens distintos en llamadas sucesivas', () => {
      expect(randomToken()).not.toBe(randomToken())
    })
  })
})
