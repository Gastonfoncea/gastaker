// src/sources/index.js
//
// Registry de fuentes de gastos. Para sumar una fuente nueva (ej. Mercado Pago):
// creás src/sources/mercadopago.js con la misma interfaz { id, name, parse }
// y la agregás a este array. No hace falta tocar nada más del sistema.

import { santander } from './santander.js'

const SOURCES = [santander]

// Prueba las fuentes en orden y devuelve el primer parseo exitoso, con el
// campo `source` agregado. Devuelve null si ninguna fuente lo reconoce.
// email = { body, subject?, from? }
export function parseEmail(email) {
  for (const source of SOURCES) {
    const parsed = source.parse(email)
    if (parsed) return { ...parsed, source: source.id }
  }
  return null
}

export { SOURCES }
