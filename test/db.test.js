// test/db.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb } from '../src/db.js'

function sampleRecord(overrides = {}) {
  return {
    gmail_message_id: 'msg-1',
    amount: 12946.0,
    merchant: 'VERDULERIA KATIE',
    category: 'Comida',
    card: '1458',
    occurred_at: '2026-06-08T19:12:00',
    ...overrides,
  }
}

describe('db', () => {
  let db
  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('inserta un gasto y lo lista', () => {
    const res = db.insert(sampleRecord())
    expect(res.inserted).toBe(true)
    const rows = db.list('2026-06')
    expect(rows).toHaveLength(1)
    expect(rows[0].merchant).toBe('VERDULERIA KATIE')
    expect(rows[0].amount).toBe(12946.0)
  })

  it('no inserta dos veces el mismo gmail_message_id', () => {
    db.insert(sampleRecord())
    const res = db.insert(sampleRecord())
    expect(res.inserted).toBe(false)
    expect(db.list('2026-06')).toHaveLength(1)
  })

  it('filtra por mes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', occurred_at: '2026-06-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', occurred_at: '2026-07-01T10:00:00' }))
    expect(db.list('2026-06')).toHaveLength(1)
    expect(db.list('2026-07')).toHaveLength(1)
  })

  it('actualiza la categoría de un gasto', () => {
    db.insert(sampleRecord())
    const id = db.list('2026-06')[0].id
    const changed = db.updateCategory(id, 'Supermercado')
    expect(changed).toBe(true)
    expect(db.list('2026-06')[0].category).toBe('Supermercado')
  })
})
