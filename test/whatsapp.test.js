// test/whatsapp.test.js
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyKapsoSignature } from '../src/whatsapp.js'

const secret = 'test-secret'
const payload = { message: { from: '549', text: { body: 'hola' } } }
const sign = (p, s) => crypto.createHmac('sha256', s).update(JSON.stringify(p)).digest('hex')

describe('verifyKapsoSignature', () => {
  it('acepta una firma válida', () => {
    expect(verifyKapsoSignature(payload, sign(payload, secret), secret)).toBe(true)
  })
  it('rechaza una firma de otro secreto', () => {
    expect(verifyKapsoSignature(payload, sign(payload, 'otro'), secret)).toBe(false)
  })
  it('rechaza si falta la firma o el secreto', () => {
    expect(verifyKapsoSignature(payload, '', secret)).toBe(false)
    expect(verifyKapsoSignature(payload, 'abc', '')).toBe(false)
  })
})
