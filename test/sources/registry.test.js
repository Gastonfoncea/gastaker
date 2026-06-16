// test/sources/registry.test.js
import { describe, it, expect } from 'vitest'
import { parseEmail } from '../../src/sources/index.js'

describe('parseEmail (registry de fuentes)', () => {
  it('agrega el campo source cuando una fuente reconoce el mail', () => {
    const r = parseEmail({
      body: `Monto
*$12.946,00*
Comercio
*VERDULERIA KATIE*
Fecha
*08/06/2026*
Hora
*19:12*`,
    })
    expect(r).not.toBeNull()
    expect(r.source).toBe('santander')
    expect(r.amount).toBe(12946.0)
  })

  it('devuelve null si ninguna fuente reconoce el mail', () => {
    expect(parseEmail({ body: 'newsletter cualquiera, nada de gastos' })).toBeNull()
  })
})
