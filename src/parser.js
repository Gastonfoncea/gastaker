// src/parser.js

// Toma el texto plano de un mail de gasto de Santander y devuelve
// { amount, merchant, occurredAt, card, type } o null si no matchea.
export function parseExpenseEmail(text) {
  if (!text) return null

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const monto = valueAfterLabel(lines, 'Monto')
  const comercio = valueAfterLabel(lines, 'Comercio')
  const fecha = valueAfterLabel(lines, 'Fecha')
  const hora = valueAfterLabel(lines, 'Hora')

  if (!monto || !comercio) return null

  const amount = parseAmount(monto)
  if (amount === null) return null

  return {
    amount,
    merchant: comercio,
    occurredAt: toIso(fecha, hora),
    card: parseCard(text),
    type: parseType(text),
  }
}

// Busca una línea igual a `label` y devuelve la línea siguiente (el valor).
function valueAfterLabel(lines, label) {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase())
  if (i === -1 || i + 1 >= lines.length) return null
  return lines[i + 1]
}

// "$12.946,00" -> 12946.00 ; "$1.500.000,50" -> 1500000.50
function parseAmount(raw) {
  const cleaned = raw.replace(/[^\d.,]/g, '') // deja solo dígitos, . y ,
  if (!cleaned) return null
  const normalized = cleaned.replace(/\./g, '').replace(',', '.')
  const n = Number.parseFloat(normalized)
  return Number.isNaN(n) ? null : n
}

// "08/06/2026" + "19:12" -> "2026-06-08T19:12:00"
function toIso(fecha, hora) {
  if (!fecha) return null
  const m = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const time = (hora && /^\d{1,2}:\d{2}/.test(hora) ? hora : '00:00').padStart(5, '0')
  return `${yyyy}-${mm}-${dd}T${time}:00`
}

function parseCard(text) {
  const m = text.match(/terminada en (\d{4})/i)
  return m ? m[1] : null
}

function parseType(text) {
  if (/cr[eé]dito/i.test(text)) return 'Crédito'
  if (/d[eé]bito/i.test(text)) return 'Débito'
  return null
}
