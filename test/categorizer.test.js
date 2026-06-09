// test/categorizer.test.js
import { describe, it, expect } from 'vitest'
import { categorize } from '../src/categorizer.js'

describe('categorize', () => {
  it('asigna categoría por coincidencia de substring', () => {
    expect(categorize('VERDULERIA KATIE')).toBe('Comida')
    expect(categorize('PEDIDOSYA')).toBe('Comida')
  })

  it('es case-insensitive', () => {
    expect(categorize('verduleria katie')).toBe('Comida')
  })

  it('devuelve Otros si no hay regla que matchee', () => {
    expect(categorize('COMERCIO RARO SA')).toBe('Otros')
  })
})
