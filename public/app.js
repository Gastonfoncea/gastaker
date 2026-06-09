const CATEGORIES = [
  'Comida', 'Supermercado', 'Transporte', 'Servicios',
  'Suscripciones', 'Salud', 'Otros',
]

const $ = (sel) => document.querySelector(sel)

function fmt(n) {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2 })
}

function monthValue() {
  return $('#month').value || new Date().toISOString().slice(0, 7)
}

async function load() {
  const res = await fetch(`/api/expenses?month=${monthValue()}`)
  if (res.status === 401) {
    showLogin()
    return
  }
  const data = await res.json()
  showApp()
  renderTotals(data.totals)
  renderList(data.expenses)
}

function renderTotals(totals) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1])
  $('#totals').innerHTML = entries.length
    ? entries.map(([cat, sum]) => `<div class="chip">${cat} <strong>${fmt(sum)}</strong></div>`).join('')
    : ''
}

function renderList(expenses) {
  if (!expenses.length) {
    $('#list').innerHTML = '<div class="empty">Sin gastos este mes</div>'
    return
  }
  $('#list').innerHTML = expenses.map((e) => {
    const date = e.occurred_at.slice(0, 16).replace('T', ' ')
    const options = CATEGORIES
      .map((c) => `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`)
      .join('')
    return `
      <div class="expense">
        <div>
          <div class="merchant">${e.merchant}</div>
          <div class="meta">${date} · ${e.card ? '••' + e.card : ''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <select data-id="${e.id}">${options}</select>
          <div class="amount">${fmt(e.amount)}</div>
        </div>
      </div>`
  }).join('')

  document.querySelectorAll('.expense select').forEach((sel) => {
    sel.addEventListener('change', async (ev) => {
      await fetch(`/api/expenses/${ev.target.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: ev.target.value }),
      })
      load()
    })
  })
}

function showLogin() {
  $('#login').classList.remove('hidden')
  $('#app').classList.add('hidden')
}
function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#password').value }),
  })
  if (res.ok) {
    $('#login-error').classList.add('hidden')
    load()
  } else {
    $('#login-error').classList.remove('hidden')
  }
})

$('#month').addEventListener('change', load)
$('#month').value = new Date().toISOString().slice(0, 7)
load()
