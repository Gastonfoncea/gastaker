// scripts/test-whatsapp.js
// Prueba de envío. Uso:
//   node --env-file=.env scripts/test-whatsapp.js 5493513071645
// Si no pasás número, usa NOTIFY_WHATSAPP del .env.
import { sendWhatsApp } from '../src/whatsapp.js'

const to = process.argv[2] || process.env.NOTIFY_WHATSAPP
if (!to) {
  console.error('Pasá un número: node --env-file=.env scripts/test-whatsapp.js <numero>')
  process.exit(1)
}

try {
  const r = await sendWhatsApp(to, 'Hola 👋 soy gastaker — andando por Kapso.')
  console.log('✅ Enviado. Respuesta de Kapso:', JSON.stringify(r))
} catch (e) {
  console.error('❌ Falló:', e.message)
  process.exit(1)
}
