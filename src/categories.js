// src/categories.js
// Tabla de reglas: si el nombre del comercio CONTIENE `match` (case-insensitive),
// se le asigna `category`. Se evalúan en orden; la primera que matchea gana.
// Editá esta lista a gusto agregando tus comercios habituales.
export const RULES = [
  { match: 'VERDULERIA', category: 'Comida' },
  { match: 'PEDIDOSYA', category: 'Comida' },
  { match: 'RAPPI', category: 'Comida' },
  { match: 'CARREFOUR', category: 'Supermercado' },
  { match: 'COTO', category: 'Supermercado' },
  { match: 'DIA', category: 'Supermercado' },
  { match: 'YPF', category: 'Transporte' },
  { match: 'SHELL', category: 'Transporte' },
  { match: 'UBER', category: 'Transporte' },
  { match: 'SUBE', category: 'Transporte' },
  { match: 'NETFLIX', category: 'Suscripciones' },
  { match: 'SPOTIFY', category: 'Suscripciones' },
  { match: 'FARMACIA', category: 'Salud' },
  { match: 'EDENOR', category: 'Servicios' },
  { match: 'METROGAS', category: 'Servicios' },
]

export const DEFAULT_CATEGORY = 'Otros'
