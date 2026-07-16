// src/sources/santander.js
//
// Fuente de gastos: Santander Argentina (avisos por email).
// Conoce SUS formatos de mail y los parsea al shape normalizado de Expense.
// Toda la lógica específica de Santander vive acá.
//
// Maneja: consumo débito, consumo crédito, débito automático (ARS o USD) y
// transferencias. Descarta lo que NO es gasto: anulaciones quedan en negativo;
// resúmenes, vencimientos y promos se ignoran.
//
// Los valores vienen en negrita markdown (*valor*), por eso se limpian los `*`
// que envuelven cada valor (conservando los `*` internos de "PAYU*AR*UBER").

export const santander = {
  id: 'santander',
  name: 'Santander Argentina',

  // parse(email) -> Expense { amount, currency, merchant, occurredAt, card, type, kind }
  // o null si el mail no es un gasto reconocible de Santander.
  // email = { body, subject?, from? }
  parse(email) {
    return parseBody(email?.body || '')
  },
}

function parseBody(text) {
  if (!text) return null
  if (isIgnored(text)) return null

  const pago = parsePagoTarjeta(text)
  if (pago) return pago

  const isAnulacion = /se anul[óo] el pago|pago.{0,20}anulad|anulaci[óo]n de consumo/i.test(text)
  const isTransfer = /Destinatario|CBU de Destino|N[úu]mero de comprobante/i.test(text)

  const rawAmount = isTransfer ? valueAfter(text, 'Importe') : valueAfter(text, 'Monto')
  if (!rawAmount) return null
  let amount = parseAmount(rawAmount)
  if (amount === null) return null
  if (isAnulacion) amount = -Math.abs(amount) // una anulación resta del total

  const currency = /U\$S|US\$|USD/i.test(rawAmount) ? 'USD' : 'ARS'

  const merchant = isTransfer ? transferMerchant(text) : valueAfter(text, 'Comercio')
  if (!merchant) return null

  return {
    amount,
    currency,
    merchant,
    occurredAt: toIso(valueAfter(text, 'Fecha'), valueAfter(text, 'Hora')),
    card: parseCard(text),
    type: parseType(text),
    kind: isAnulacion ? 'anulacion' : isTransfer ? 'transferencia' : 'consumo',
  }
}

// Mails que NO son movimientos: resúmenes, vencimientos, promos.
// (Las anulaciones SÍ son movimientos: se guardan en negativo.)
function isIgnored(text) {
  return (
    /resumen de tu tarjeta|fecha de cierre|importe en pesos|importe en d[óo]lares/i.test(text) ||
    /pr[óo]ximo a vencer/i.test(text) ||
    /superclub|puntos acumulados/i.test(text)
  )
}

// Valor que sigue a una etiqueta (misma línea o la siguiente). Limpia la
// negrita markdown que envuelve el valor, conservando los `*` internos.
function valueAfter(text, label) {
  const m = text.match(new RegExp(`${label}\\s*([^\\n\\r]+)`, 'i'))
  if (!m) return null
  const v = m[1].replace(/^[\s*]+/, '').replace(/[\s*]+$/, '').trim()
  return v || null
}

function transferMerchant(text) {
  const dest = valueAfter(text, 'Destinatario')
  return dest ? `Transferencia · ${dest}` : 'Transferencia'
}

// "$12.946,00" -> 12946.00 ; "U$S3,29" -> 3.29 ; "$ 8.500,00" -> 8500
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

// "terminada en *1458*." -> "1458"
function parseCard(text) {
  const m = text.match(/terminada en[*\s]*(\d{4})/i)
  return m ? m[1] : null
}

function parseType(text) {
  if (/cr[eé]dito/i.test(text)) return 'Crédito'
  if (/d[eé]bito/i.test(text)) return 'Débito'
  return null
}

// Mail "pago de tu tarjeta": Santander debitó el resumen de la cuenta.
// Es plata que sale de la cuenta HOY (los consumos con crédito individuales
// no suman al total; este débito sí). El monto de "Debitamos" incluye el
// saldo en dólares convertido a pesos. El mail no trae Fecha/Hora: occurredAt
// queda null y la ingesta usa receivedAt.
function parsePagoTarjeta(text) {
  if (!/Debitamos/i.test(text) || !/pago de tu Tarjeta/i.test(text)) return null
  const m = text.match(/Debitamos[\s*]*\$\s*([\d.,]+)/i)
  if (!m) return null
  const amount = parseAmount(m[1])
  if (amount === null) return null
  // Espacio horizontal ([ \t], no \s): el asunto "Información sobre el pago de
  // tu tarjeta" también matchea, y con \s+ el regex cruzaba el salto de línea y
  // capturaba la línea siguiente ("Hola") como marca.
  const brand = text.match(/pago de tu Tarjeta[ \t]+([^\n\r.]+)/i)
  const card = text.match(/Tarjeta[^\d\n\r]*(\d{4})/i)
  return {
    amount,
    currency: 'ARS',
    merchant: `Pago tarjeta${brand ? ' ' + brand[1].replace(/[\s*]+$/, '').trim() : ''}`,
    occurredAt: null,
    card: card ? card[1] : null,
    type: 'Débito',
    kind: 'pago_tarjeta',
  }
}
