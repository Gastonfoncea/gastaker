/* gastaker — página de registro con invitación (vanilla). */
const $ = (s) => document.querySelector(s)
const token = new URLSearchParams(location.search).get('token')

async function init() {
  // Valida el invite antes de mostrar el form (sin exponer datos: solo válido/inválido).
  const res = await fetch(`/api/invites/${encodeURIComponent(token || '')}`)
  const data = await res.json().catch(() => ({ valid: false }))
  if (!data.valid) {
    $('#reg-fields').classList.add('hidden')
    $('#reg-invalid').classList.remove('hidden')
    $('#reg-sub').textContent = 'Necesitás una invitación válida.'
  }
}

$('#reg-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, email: $('#reg-email').value.trim(), password: $('#reg-password').value }),
  })
  if (res.ok) {
    location.href = '/' // ya queda logueado por la cookie
    return
  }
  const e = await res.json().catch(() => ({}))
  const err = $('#reg-error')
  if (res.status === 409) err.textContent = 'Ese email ya está registrado.'
  else if (res.status === 410) err.textContent = 'La invitación ya no es válida.'
  else err.textContent = e.error || 'No se pudo crear la cuenta.'
  err.classList.remove('hidden')
})

init()
