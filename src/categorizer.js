// src/categorizer.js
import { RULES, DEFAULT_CATEGORY } from './categories.js'

// Dado el nombre de un comercio, devuelve la categoría según las reglas.
export function categorize(merchant) {
  if (!merchant) return DEFAULT_CATEGORY
  const upper = merchant.toUpperCase()
  for (const rule of RULES) {
    if (upper.includes(rule.match.toUpperCase())) return rule.category
  }
  return DEFAULT_CATEGORY
}
