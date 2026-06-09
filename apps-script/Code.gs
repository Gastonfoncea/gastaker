// Gastaker — poller de Gmail.
// Pegá este archivo en https://script.google.com (proyecto nuevo),
// completá las 3 constantes, autorizalo, y poné un trigger de tiempo
// (cada 5 min) sobre la función sync.

const WEBHOOK_URL = 'https://TU-DOMINIO-O-IP/api/ingest' // ej: https://gastaker.tudominio.com/api/ingest
const WEBHOOK_SECRET = 'PEGA-ACA-EL-MISMO-WEBHOOK_SECRET-DEL-VPS'
const SENDER = 'mensajesyavisos@mails.santander.com.ar'
const LABEL_NAME = 'gastaker-procesado'

function sync() {
  const label = getOrCreateLabel(LABEL_NAME)
  // Mails del remitente que todavía no procesamos.
  const threads = GmailApp.search(`from:${SENDER} -label:${LABEL_NAME}`, 0, 50)

  threads.forEach((thread) => {
    let allOk = true
    thread.getMessages().forEach((msg) => {
      const payload = {
        messageId: msg.getId(),
        subject: msg.getSubject(),
        body: msg.getPlainBody(),
        receivedAt: msg.getDate().toISOString(),
      }
      const res = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      })
      if (res.getResponseCode() !== 200) allOk = false
    })
    // Solo etiquetamos como procesado si el VPS recibió todo OK.
    if (allOk) thread.addLabel(label)
  })
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name)
}
