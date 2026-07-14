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

  it('clasificarGasto actualiza la categoría de un gasto', () => {
    db.insert(sampleRecord())
    const id = db.list('2026-06')[0].id
    const changed = db.clasificarGasto(id, 'Supermercado')
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

  it('marca needs_review y lo lista en pendientes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'p', category: 'Otros', needs_review: 1 }))
    const pend = db.pendientes()
    expect(pend).toHaveLength(1)
    expect(pend[0].comercio).toBe('VERDULERIA KATIE')
  })

  it('findLearned matchea por substring del comercio', () => {
    db.registrarComercio({ match: '20520522523', categoria: 'Vivienda', alias: 'Alquiler' })
    expect(db.findLearned('Transferencia · 20520522523')).toBe('Vivienda')
    expect(db.findLearned('OTRO COMERCIO')).toBeNull()
  })

  it('clasificarGasto setea la categoría de un gasto y limpia needs_review', () => {
    db.insert(sampleRecord({ gmail_message_id: 'g', category: 'Otros', needs_review: 1 }))
    const id = db.list('2026-06')[0].id
    expect(db.clasificarGasto(id, 'Salud')).toBe(true)
    const row = db.list('2026-06')[0]
    expect(row.category).toBe('Salud')
    expect(row.needs_review).toBe(0)
  })

  it('registrarComercio guarda la regla y re-clasifica los que matchean', () => {
    db.insert(sampleRecord({ gmail_message_id: 't', merchant: 'Transferencia · 999', category: 'Transferencias', needs_review: 1 }))
    const r = db.registrarComercio({ match: '999', categoria: 'Vivienda', alias: 'Alquiler' })
    expect(r.inserted).toBe(true)
    expect(r.actualizados).toBe(1)
    expect(db.list('2026-06')[0].category).toBe('Vivienda')
    expect(db.list('2026-06')[0].needs_review).toBe(0)
  })

  it('registrarComercio pisa también el histórico ya categorizado', () => {
    // Un gasto viejo, ya categorizado (needs_review = 0), del mismo comercio.
    db.insert(sampleRecord({ gmail_message_id: 'viejo', merchant: 'PAYU*AR*UBER', category: 'Otros', needs_review: 0 }))
    db.insert(sampleRecord({ gmail_message_id: 'pend', merchant: 'PAYU*AR*UBER', category: 'Otros', needs_review: 1 }))
    const r = db.registrarComercio({ match: 'PAYU*AR*UBER', categoria: 'Transporte' })
    expect(r.actualizados).toBe(2)
    for (const row of db.list('2026-06')) {
      expect(row.category).toBe('Transporte')
      expect(row.needs_review).toBe(0)
    }
  })

  it('registrarComercio rechaza un match genérico o muy corto', () => {
    expect(() => db.registrarComercio({ match: 'transferencia', categoria: 'X' })).toThrow()
    expect(() => db.registrarComercio({ match: 'ab', categoria: 'X' })).toThrow()
  })

  // Devuelve el e.code del error que lanza fn, o null si no lanzó.
  const codeOf = (fn) => {
    try {
      fn()
      return null
    } catch (e) {
      return e.code
    }
  }

  describe('categorías', () => {
    it('seedea las 8 categorías iniciales con color', () => {
      const cats = db.listCategories()
      expect(cats.map((c) => c.name)).toEqual([
        'Comida', 'Supermercado', 'Transporte', 'Servicios',
        'Suscripciones', 'Salud', 'Transferencias', 'Otros',
      ])
      expect(cats[0].color).toBe('#FF6B35')
      expect(cats[0].count).toBe(0)
    })

    it('listCategories cuenta los gastos de cada categoría', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // Comida
      db.insert(sampleRecord({ gmail_message_id: 'b' })) // Comida
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      expect(comida.count).toBe(2)
    })

    it('createCategory crea con nombre y color válidos', () => {
      const c = db.createCategory({ name: 'Ropa', color: '#EF4444' })
      expect(c.id).toBeTruthy()
      expect(db.listCategories().some((x) => x.name === 'Ropa')).toBe(true)
    })

    it('createCategory rechaza duplicados (case-insensitive) con code DUP', () => {
      expect(codeOf(() => db.createCategory({ name: 'comida', color: '#EF4444' }))).toBe('DUP')
    })

    it('createCategory valida nombre y color con code VALIDATION', () => {
      expect(codeOf(() => db.createCategory({ name: '  ', color: '#EF4444' }))).toBe('VALIDATION')
      expect(codeOf(() => db.createCategory({ name: 'Ropa', color: 'rojo' }))).toBe('VALIDATION')
    })

    it('updateCategoryDef renombra y cascadea a expenses y comercios_conocidos', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // category: Comida
      db.registrarComercio({ match: 'VERDULERIA', categoria: 'Comida' })
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      db.updateCategoryDef(comida.id, { name: 'Morfi' })
      expect(db.list('2026-06')[0].category).toBe('Morfi')
      expect(db.findLearned('VERDULERIA KATIE')).toBe('Morfi')
      expect(db.listCategories().some((c) => c.name === 'Morfi')).toBe(true)
    })

    it('updateCategoryDef no renombra Otros pero sí le cambia el color', () => {
      const otros = db.listCategories().find((c) => c.name === 'Otros')
      expect(codeOf(() => db.updateCategoryDef(otros.id, { name: 'Misc' }))).toBe('PROTECTED')
      const r = db.updateCategoryDef(otros.id, { color: '#111111' })
      expect(r.color).toBe('#111111')
    })

    it('deleteCategory mueve los gastos a Otros y borra las reglas', () => {
      db.insert(sampleRecord({ gmail_message_id: 'a' })) // Comida
      db.registrarComercio({ match: 'VERDULERIA', categoria: 'Comida' })
      const comida = db.listCategories().find((c) => c.name === 'Comida')
      const r = db.deleteCategory(comida.id)
      expect(r.movidos).toBe(1)
      expect(db.list('2026-06')[0].category).toBe('Otros')
      expect(db.findLearned('VERDULERIA KATIE')).toBe(null)
      expect(db.listCategories().some((c) => c.name === 'Comida')).toBe(false)
    })

    it('deleteCategory rechaza Otros e inexistentes', () => {
      const otros = db.listCategories().find((c) => c.name === 'Otros')
      expect(codeOf(() => db.deleteCategory(otros.id))).toBe('PROTECTED')
      expect(codeOf(() => db.deleteCategory(9999))).toBe('NOT_FOUND')
    })
  })
})
