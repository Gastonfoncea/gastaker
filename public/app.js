/* gastaker — frontend (vanilla). Ledger view, month stepper, inline recat. */

const CATS = [
  { name: 'Comida', color: '#e2603b' },
  { name: 'Supermercado', color: '#0d9488' },
  { name: 'Transporte', color: '#2563eb' },
  { name: 'Servicios', color: '#7c3aed' },
  { name: 'Suscripciones', color: '#db2777' },
  { name: 'Salud', color: '#16a34a' },
  { name: 'Otros', color: '#71717a' },
]
const COLOR = Object.fromEntries(CATS.map((c) => [c.name, c.color]))
const colorOf = (name) => COLOR[name] || '#71717a'

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

const $ = (s) => document.querySelector(s)
let currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM

/* ---------- formato ---------- */
function parts(n) {
  const [int, cents] = Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2 }).split(',')
  return { int, cents }
}
function money(n) {
  const { int, cents } = parts(n)
  return `$${int}<span class="cents">,${cents}</span>`
}
function moneyShort(n) {
  return '$' + Math.round(n).toLocaleString('es-AR')
}
function fmtDate(iso) {
  // "2026-06-08T19:12:00" -> { day: "08/06", time: "19:12" }
  const [date, t = ''] = iso.split('T')
  const [, mo, da] = date.split('-')
  return { day: `${da}/${mo}`, time: t.slice(0, 5) }
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/* ---------- carga ---------- */
async function load() {
  const res = await fetch(`/api/expenses?month=${currentMonth}`)
  if (res.status === 401) return showLogin()
  const data = await res.json()
  showApp()
  $('#month-label').textContent = monthLabel(currentMonth)
  render(data)
}

function render({ expenses, totals }) {
  const total = Object.values(totals).reduce((a, b) => a + b, 0)
  $('#total').innerHTML = total ? money(total) : '<span class="muted">$0</span>'

  // barra de proporción + leyenda (ordenadas por monto)
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1])
  $('#bar').innerHTML = ranked
    .map(([cat, sum]) => `<span data-w="${(sum / total) * 100}" style="background:${colorOf(cat)}"></span>`)
    .join('')
  // animar el width en el próximo frame
  requestAnimationFrame(() => {
    $('#bar').querySelectorAll('span').forEach((el) => {
      el.style.width = el.dataset.w + '%'
    })
  })
  $('#legend').innerHTML = ranked
    .map(
      ([cat, sum]) => `<li>
        <span class="dot" style="background:${colorOf(cat)}"></span>
        <span class="lg-name">${cat}</span>
        <span class="lg-amount">${moneyShort(sum)}</span>
      </li>`
    )
    .join('')

  // ledger
  const empty = expenses.length === 0
  $('#movs-count').textContent = empty
    ? ''
    : `${expenses.length} ${expenses.length === 1 ? 'gasto' : 'gastos'}`
  $('#empty').classList.toggle('hidden', !empty)
  $('#ledger').innerHTML = empty
    ? ''
    : expenses
        .map((e, i) => {
          const { day, time } = fmtDate(e.occurred_at)
          const card = e.card ? `<span class="row-card">•${e.card}</span>` : ''
          return `<div class="row" style="animation-delay:${Math.min(i * 22, 260)}ms">
            <div class="cell-date"><span class="d-day">${day}</span><span class="d-time">${time}</span></div>
            <div class="cell-merchant">
              <span class="row-merchant">${escape(e.merchant)}</span>${card}
            </div>
            <button class="cat" data-id="${e.id}" data-cat="${e.category}">
              <span class="dot" style="background:${colorOf(e.category)}"></span>${e.category}
            </button>
            <div class="row-amount">${money(e.amount)}</div>
          </div>`
        })
        .join('')

  $('#ledger').querySelectorAll('.cat').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      openCatMenu(btn, Number(btn.dataset.id), btn.dataset.cat)
    })
  })
}

function escape(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

/* ---------- popover de categorías ---------- */
const menu = $('#catmenu')

function openCatMenu(anchor, id, current) {
  menu.innerHTML = CATS.map(
    (c) => `<button data-name="${c.name}" aria-current="${c.name === current}">
      <span class="dot" style="background:${c.color}"></span>${c.name}
      <span class="check">✓</span>
    </button>`
  ).join('')

  const r = anchor.getBoundingClientRect()
  menu.classList.remove('hidden')
  // posicionar; si no entra abajo, abrir hacia arriba
  const mh = menu.offsetHeight
  const below = r.bottom + 6
  const top = below + mh > window.innerHeight ? r.top - mh - 6 : below
  menu.style.top = `${Math.max(8, top)}px`
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const name = b.dataset.name
      closeMenu()
      if (name !== current) {
        await fetch(`/api/expenses/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: name }),
        })
        load()
      }
    })
  })
}
function closeMenu() {
  menu.classList.add('hidden')
}
document.addEventListener('click', closeMenu)
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu())
window.addEventListener('scroll', closeMenu, true)

/* ---------- vistas ---------- */
function showLogin() {
  $('#login').classList.remove('hidden')
  $('#app').classList.add('hidden')
  $('#password')?.focus()
}
function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
}

/* ---------- eventos ---------- */
$('#prev').addEventListener('click', () => {
  currentMonth = shiftMonth(currentMonth, -1)
  load()
})
$('#next').addEventListener('click', () => {
  currentMonth = shiftMonth(currentMonth, 1)
  load()
})

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
    $('#password').value = ''
  }
})

load()
