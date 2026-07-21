// test/manual-expense.test.js — alta manual de gastos y borrado (solo manuales).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { makeUserDb, makeAppWithUser, authedAgent } from './helpers.js'

const gasto = (over = {}) => ({
  gmail_message_id: `m-${Math.random()}`,
  amount: 100,
  merchant: 'X',
  category: 'Comida',
  occurred_at: '2026-07-01T10:00:00',
  ...over,
})

describe('db: insert() devuelve id y deleteExpense()', () => {
  it('insert() devuelve el id de la fila insertada', () => {
    const { udb } = makeUserDb()
    const r = udb.insert(gasto())
    expect(r.inserted).toBe(true)
    expect(udb.getExpense(r.id).merchant).toBe('X')
  })

  it('deleteExpense() borra el gasto propio y devuelve true', () => {
    const { udb } = makeUserDb()
    const r = udb.insert(gasto())
    expect(udb.deleteExpense(r.id)).toBe(true)
    expect(udb.getExpense(r.id)).toBeUndefined()
  })

  it('deleteExpense() no borra gastos de otro usuario', () => {
    const { db, udb } = makeUserDb()
    const r = udb.insert(gasto())
    const otro = db.createUser({ email: 'otro@test.com', password: 'x' })
    expect(db.forUser(otro.id).deleteExpense(r.id)).toBe(false)
    expect(udb.getExpense(r.id)).toBeDefined()
  })
})
