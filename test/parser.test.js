// test/parser.test.js
import { describe, it, expect } from 'vitest'
import { parseExpenseEmail } from '../src/parser.js'

const SAMPLE = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/06/2026

Hora
19:12`

describe('parseExpenseEmail', () => {
  it('extrae monto, comercio, fecha/hora y tarjeta', () => {
    const r = parseExpenseEmail(SAMPLE)
    expect(r).not.toBeNull()
    expect(r.amount).toBe(12946.0)
    expect(r.merchant).toBe('VERDULERIA KATIE')
    expect(r.occurredAt).toBe('2026-06-08T19:12:00')
    expect(r.card).toBe('1458')
    expect(r.type).toBe('Débito')
  })

  it('parsea montos sin decimales y con miles', () => {
    const body = SAMPLE.replace('$12.946,00', '$1.500.000,50')
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(1500000.5)
  })

  it('detecta tarjeta de crédito', () => {
    const body = SAMPLE.replace('Visa Débito', 'Visa Crédito')
    const r = parseExpenseEmail(body)
    expect(r.type).toBe('Crédito')
  })

  it('devuelve null si falta el Monto o el Comercio', () => {
    expect(parseExpenseEmail('hola, esto no es un gasto')).toBeNull()
  })
})
