// src/whatsapp.js
// Envía mensajes de WhatsApp vía Kapso (que es un proxy de la Meta Cloud API).
// La API key y el phoneNumberId se leen del entorno; nunca van en el código.

import crypto from 'node:crypto'

const API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0'

// Envía un mensaje de texto a `to` (número en formato internacional sin '+').
// Devuelve la respuesta de Kapso; lanza error si falla.
export async function sendWhatsApp(to, text) {
  const apiKey = process.env.KAPSO_API_KEY
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID
  if (!apiKey || !phoneNumberId) {
    throw new Error('Faltan KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID en el entorno (.env)')
  }

  const res = await fetch(`${API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Kapso respondió ${res.status}: ${JSON.stringify(data)}`)
  }
  return data
}

// Verifica la firma HMAC-SHA256 que Kapso manda en el header X-Webhook-Signature.
// Kapso firma JSON.stringify(payload) con tu secreto, en hex (sin prefijo).
export function verifyKapsoSignature(payload, signature, secret) {
  if (!signature || !secret) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
