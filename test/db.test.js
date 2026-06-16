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

  it('guarda la moneda (default ARS) y persiste USD', () => {
    db.insert(sampleRecord({ gmail_message_id: 'ars' })) // sin currency -> ARS
    db.insert(sampleRecord({ gmail_message_id: 'usd', currency: 'USD', amount: 6.33 }))
    const rows = db.list('2026-06')
    const byId = Object.fromEntries(rows.map((r) => [r.gmail_message_id, r]))
    expect(byId.ars.currency).toBe('ARS')
    expect(byId.usd.currency).toBe('USD')
  })

  it('resumenMes devuelve totales por moneda y por categoría (solo neto > 0)', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', amount: 1000, category: 'Comida', occurred_at: '2026-06-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', amount: 500, category: 'Comida', occurred_at: '2026-06-02T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'c', amount: 6.33, currency: 'USD', category: 'Suscripciones', occurred_at: '2026-06-03T10:00:00' }))
    const r = db.resumenMes('2026-06')
    expect(r.totalArs).toBe(1500)
    expect(r.totalUsd).toBe(6.33)
    expect(r.categoriasArs).toEqual({ Comida: 1500 })
  })

  it('listarGastos filtra por categoría y comercio', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', merchant: 'UBER', category: 'Transporte' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', merchant: 'VERDU', category: 'Comida' }))
    expect(db.listarGastos({ month: '2026-06', categoria: 'Transporte' })).toHaveLength(1)
    expect(db.listarGastos({ month: '2026-06', comercio: 'VERD' })).toHaveLength(1)
    expect(db.listarGastos({ month: '2026-06' })).toHaveLength(2)
  })

  it('compararMeses devuelve totales de cada mes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', amount: 100, occurred_at: '2026-05-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', amount: 200, occurred_at: '2026-06-01T10:00:00' }))
    const r = db.compararMeses('2026-05', '2026-06')
    expect(r['2026-05'].totalArs).toBe(100)
    expect(r['2026-06'].totalArs).toBe(200)
  })
})
