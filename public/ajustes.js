/* gastaker — página de Ajustes (vanilla). */
const $ = (s) => document.querySelector(s)

async function load() {
  const res = await fetch('/api/me')
  if (res.status === 401) {
    location.href = '/'
    return
  }
  const me = await res.json()
  $('#ingest-token').value = me.ingest_token
  $('#wa-number').value = me.whatsapp_number || ''
  // El botón de invitar solo se muestra si el usuario es admin (el backend igual
  // devuelve 403 si lo llaman a mano).
  if (me.is_admin === 1) $('#invite-block').classList.remove('hidden')
}

function copy(input, btn) {
  input.select()
  navigator.clipboard?.writeText(input.value)
  const old = btn.textContent
  btn.textContent = 'Copiado ✓'
  setTimeout(() => (btn.textContent = old), 1400)
}

$('#copy-token').addEventListener('click', () => copy($('#ingest-token'), $('#copy-token')))

$('#wa-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const res = await fetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp_number: $('#wa-number').value.trim() }),
  })
  const msg = $('#wa-msg')
  if (res.ok) {
    msg.textContent = 'Guardado ✓'
    msg.className = 'ok-msg'
  } else {
    const e = await res.json().catch(() => ({}))
    msg.textContent = res.status === 409 ? 'Ese número ya está en uso' : e.error || 'No se pudo guardar'
    msg.className = 'login-error'
  }
})

$('#invite-btn').addEventListener('click', async () => {
  const res = await fetch('/api/invites', { method: 'POST' })
  if (!res.ok) {
    alert('No se pudo generar la invitación')
    return
  }
  const { url } = await res.json()
  $('#invite-url').value = url
  $('#invite-result').classList.remove('hidden')
})
$('#copy-invite').addEventListener('click', () => copy($('#invite-url'), $('#copy-invite')))

load()
