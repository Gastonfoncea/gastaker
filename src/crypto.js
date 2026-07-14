// src/crypto.js
// Helpers de crypto con node:crypto (cero dependencias nuevas).
// Reutilizables por db.js, register y los scripts CLI.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Hashea una password en el formato "scrypt$<saltHex>$<hashHex>".
// Salt aleatorio de 16 bytes; hash scrypt de 64 bytes.
export function hashPassword(plain) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(plain), salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

// Verifica una password contra un string guardado por hashPassword.
// Re-deriva con el salt guardado y compara con timingSafeEqual.
// Devuelve false ante cualquier formato inválido, en vez de tirar.
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, saltHex, hashHex] = parts
  let salt
  let expected
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const actual = scryptSync(String(plain), salt, expected.length)
  // timingSafeEqual exige mismo largo; expected.length lo garantiza por construcción.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// Token aleatorio en hex. bytes=24 -> 48 chars. Usado para ingest_token,
// tokens de sesión (bytes=32) e invites.
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex')
}
