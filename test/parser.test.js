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
    expect(r.currency).toBe('ARS')
    expect(r.kind).toBe('consumo')
  })

  it('parsea un consumo en dólares con etiquetas pegadas al valor', () => {
    const body = `MontoU$S6,33
ComercioMicrosoft*Xbox Game Pass
Fecha04/06/2026
Hora00:43`
    const r = parseExpenseEmail(body)
    expect(r).not.toBeNull()
    expect(r.amount).toBe(6.33)
    expect(r.currency).toBe('USD')
    expect(r.merchant).toBe('Microsoft*Xbox Game Pass')
    expect(r.occurredAt).toBe('2026-06-04T00:43:00')
    expect(r.kind).toBe('consumo')
  })

  it('parsea una transferencia (Importe / Destinatario / sin Comercio)', () => {
    const body = `Destinatario    20520522523
    Cuenta de origen    Cuenta en Pesos XXX-XXX 2910
    CBU de Destino    0000003100090368368647
    Importe    $ 1.000,00
    Número de comprobante    61949218`
    const r = parseExpenseEmail(body)
    expect(r).not.toBeNull()
    expect(r.amount).toBe(1000)
    expect(r.currency).toBe('ARS')
    expect(r.kind).toBe('transferencia')
    expect(r.merchant).toContain('20520522523')
    expect(r.occurredAt).toBeNull() // sin Fecha en el mail -> el ingest usa receivedAt
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

  // ---- formatos REALES (valores en negrita markdown *...*) ----

  it('consumo débito real (negrita)', () => {
    const body = `2668 Aviso de consumo TD
Te acercamos el detalle de tu consumo con la *Tarjeta Santander Visa Débito* terminada en *1458*.
Monto
*$12.946,00*
Comercio
*VERDULERIA KATIE*
Fecha
*08/06/2026*
Hora
*19:12*`
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(12946.0)
    expect(r.currency).toBe('ARS')
    expect(r.merchant).toBe('VERDULERIA KATIE')
    expect(r.card).toBe('1458')
    expect(r.type).toBe('Débito')
    expect(r.occurredAt).toBe('2026-06-08T19:12:00')
  })

  it('débito automático en USD', () => {
    const body = `2225 Aviso de debito automatico
Te acercamos el detalle del débito con tu *Tarjeta Santander Visa Crédito* terminada en *3967.*
Monto
*U$S3,29*
Comercio
*APPLECOMBILL*
Fecha
*08/06/2026*
Hora
*12:45*`
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(3.29)
    expect(r.currency).toBe('USD')
    expect(r.merchant).toBe('APPLECOMBILL')
    expect(r.type).toBe('Crédito')
  })

  it('consumo crédito conserva los * internos del comercio', () => {
    const body = `2033 Aviso de consumo credito
Te acercamos el detalle de tu consumo con la *Tarjeta Santander Visa Crédito* terminada en *3967*.
Monto
*$20.287,00*
Cuotas
*1*
Comercio
*PAYU*AR*UBER*
Fecha
*06/06/2026*
Hora
*21:32*`
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(20287.0)
    expect(r.merchant).toBe('PAYU*AR*UBER')
    expect(r.type).toBe('Crédito')
  })

  it('transferencia real (Importe $ X / Destinatario)', () => {
    const body = `Aviso de transferencia confirmada
Se realizó la siguiente transferencia a tu nombre:
Destinatario 20136843444
Cuenta de origen Cuenta en Pesos XXX-XXX 2910
CBU de Destino 0200912811000006536008
Importe $ 8.500,00
Número de comprobante 61649016`
    const r = parseExpenseEmail(body)
    expect(r.amount).toBe(8500.0)
    expect(r.currency).toBe('ARS')
    expect(r.kind).toBe('transferencia')
    expect(r.merchant).toContain('20136843444')
  })

  // ---- mails que NO son gastos -> null ----

  it('una anulación se guarda como monto negativo (netea)', () => {
    const body = `2034 Aviso anulacion de consumo credito
Se anuló el pago que hiciste con tu *Tarjeta Santander Visa Crédito *terminada en *3967*:
Monto
*$18.441,00*
Comercio
*PAYU*AR*UBER*`
    const r = parseExpenseEmail(body)
    expect(r).not.toBeNull()
    expect(r.amount).toBe(-18441)
    expect(r.kind).toBe('anulacion')
    expect(r.merchant).toBe('PAYU*AR*UBER')
  })

  it('descarta el resumen de tarjeta', () => {
    const body = `2467 resumentc
El resumen de tu tarjeta de crédito está próximo a vencer
Importe en pesos
$ 823.510,04
Importe en dólares
U$S 395,73
Fecha de cierre
28/05/2026`
    expect(parseExpenseEmail(body)).toBeNull()
  })

  it('descarta vencimiento y promos', () => {
    expect(parseExpenseEmail('El 10/06/2026 vence tu Tarjeta Santander AMEX terminada en 6124, próximo a vencer')).toBeNull()
    expect(parseExpenseEmail('tenés 13090 puntos acumulados SuperClub+. Compraste por $50.000,00')).toBeNull()
  })
})
