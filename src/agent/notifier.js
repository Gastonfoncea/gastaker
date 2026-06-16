// src/agent/notifier.js
import { sendWhatsApp } from '../whatsapp.js'

// Avisa por WhatsApp que entró un gasto sin clasificar.
// INACTIVO por defecto (enabled=false): en sandbox no funciona fuera de la ventana de 24hs.
// Se activa con número productivo + plantilla de utilidad (ver spec).
export async function avisarSinClasificar(expense, { enabled, to, send = sendWhatsApp }) {
  if (!enabled || !to) return
  const sym = expense.currency === 'USD' ? 'U$S ' : '$'
  const texto = `💸 Entró un gasto sin clasificar: ${expense.merchant} ${sym}${expense.amount}. ¿De qué es?`
  try {
    await send(to, texto)
  } catch (e) {
    console.error('notifier falló:', e.message)
  }
}
