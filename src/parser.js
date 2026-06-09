// src/parser.js

// Parsea el texto plano de un mail de Santander —consumo en pesos, consumo en
// dólares, o transferencia— y devuelve un objeto normalizado, o null si no
// reconoce un gasto. Es robusto a etiquetas pegadas al valor ("MontoU$S6,33")
// y a etiquetas separadas por espacios o saltos de línea ("Monto\n$12.946,00").
//
// Devuelve: { amount, currency, merchant, occurredAt, card, type, kind }
export function parseExpenseEmail(text) {
  if (!text) return null

  const isTransfer = /Destinatario|CBU de Destino|N[úu]mero de comprobante/i.test(text)

  // Monto/Importe, con o sin símbolo de moneda, pegado o separado.
  const amountMatch = text.match(/(?:Importe|Monto)\s*(U\$S|US\$|USD|\$)?\s*([\d.,]+)/i)
  if (!amountMatch) return null
  const amount = parseAmount(amountMatch[2])
  if (amount === null) return null

  const currency = /U\$S|US\$|USD/i.test(amountMatch[1] || '') ? 'USD' : 'ARS'

  const merchant = isTransfer ? transferMerchant(text) : valueAfter(text, 'Comercio')
  if (!merchant) return null

  return {
    amount,
    currency,
    merchant,
    occurredAt: toIso(valueAfter(text, 'Fecha'), valueAfter(text, 'Hora')),
    card: parseCard(text),
    type: parseType(text),
    kind: isTransfer ? 'transferencia' : 'consumo',
  }
}

// Captura el valor que sigue a una etiqueta, esté pegado o separado por
// espacios/saltos de línea. Corta al final de la línea.
function valueAfter(text, label) {
  const m = text.match(new RegExp(`${label}\\s*([^\\n\\r]+)`, 'i'))
  return m ? m[1].trim() : null
}

function transferMerchant(text) {
  const dest = valueAfter(text, 'Destinatario')
  return dest ? `Transferencia · ${dest}` : 'Transferencia'
}

// "$12.946,00" -> 12946.00 ; "1.500.000,50" -> 1500000.50 ; "6,33" -> 6.33
function parseAmount(raw) {
  const cleaned = raw.replace(/[^\d.,]/g, '')
  if (!cleaned) return null
  const normalized = cleaned.replace(/\./g, '').replace(',', '.')
  const n = Number.parseFloat(normalized)
  return Number.isNaN(n) ? null : n
}

// "08/06/2026" + "19:12" -> "2026-06-08T19:12:00" ; sin fecha -> null
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
