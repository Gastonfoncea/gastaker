/* gastaker — frontend (vanilla). Ledger view, month stepper, inline recat. */

const CATS = [
  { name: 'Comida', color: '#FF6B35' },
  { name: 'Supermercado', color: '#06B6D4' },
  { name: 'Transporte', color: '#4F46E5' },
  { name: 'Servicios', color: '#A855F7' },
  { name: 'Suscripciones', color: '#EC4899' },
  { name: 'Salud', color: '#10B981' },
  { name: 'Transferencias', color: '#F59E0B' },
  { name: 'Otros', color: '#64748B' },
]
const COLOR = Object.fromEntries(CATS.map((c) => [c.name, c.color]))
const colorOf = (name) => COLOR[name] || '#71717a'

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

const $ = (s) => document.querySelector(s)
let currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM
let activeCat = null // categoría seleccionada para filtrar la tabla
let lastData = { expenses: [] } // último payload, para re-renderizar sin refetch

/* ---------- formato ---------- */
function parts(n) {
  const [int, cents] = Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2 }).split(',')
  return { int, cents }
}
function money(n, currency) {
  const { int, cents } = parts(n)
  const sym = currency === 'USD' ? 'U$S ' : '$'
  const sign = n < 0 ? '−' : ''
  return `${sign}${sym}${int}<span class="cents">,${cents}</span>`
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
  lastData = data
  showApp()
  $('#month-label').textContent = monthLabel(currentMonth)
  render(data)
}

function render({ expenses }) {
  // Pesos y dólares no se suman: el total grande es en pesos, el USD va aparte.
  const ars = expenses.filter((e) => (e.currency || 'ARS') === 'ARS')
  const usd = expenses.filter((e) => e.currency === 'USD')
  const arsTotal = ars.reduce((s, e) => s + e.amount, 0)
  const usdTotal = usd.reduce((s, e) => s + e.amount, 0)

  $('#total').innerHTML = arsTotal ? money(arsTotal, 'ARS') : '<span class="muted">$0</span>'

  const usdEl = $('#total-usd')
  if (usdTotal > 0) {
    usdEl.innerHTML = money(usdTotal, 'USD')
    usdEl.classList.remove('hidden')
  } else {
    usdEl.classList.add('hidden')
  }

  // barra de proporción + leyenda: solo pesos, y solo categorías con neto > 0
  // (las anulaciones restan, así que una categoría puede netear a 0 y no se muestra)
  const totals = {}
  for (const e of ars) totals[e.category] = (totals[e.category] || 0) + e.amount
  const ranked = Object.entries(totals)
    .filter(([, sum]) => sum > 0)
    .sort((a, b) => b[1] - a[1])
  const barTotal = ranked.reduce((s, [, sum]) => s + sum, 0) || 1
  $('#bar').innerHTML = ranked
    .map(([cat, sum]) => `<span data-w="${(sum / barTotal) * 100}" style="background:${colorOf(cat)}" title="${cat}"></span>`)
    .join('')
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

  // filtro: dropdown con las categorías presentes este mes (Todas + cada una)
  const present = CATS.map((c) => c.name).filter((name) => expenses.some((e) => e.category === name))
  $('#cat-filter').innerHTML =
    `<option value="">Todas las categorías</option>` +
    present.map((c) => `<option value="${c}"${c === activeCat ? ' selected' : ''}>${c}</option>`).join('')

  // ledger (filtrado por la categoría activa, si hay)
  const shown = activeCat ? expenses.filter((e) => e.category === activeCat) : expenses
  const empty = shown.length === 0
  $('#movs-count').textContent = shown.length
    ? `${shown.length} ${shown.length === 1 ? 'gasto' : 'gastos'}`
    : ''
  $('#empty').classList.toggle('hidden', !empty)
  $('#ledger').innerHTML = empty
    ? ''
    : shown
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
            <div class="row-amount${e.currency === 'USD' ? ' usd' : ''}${e.amount < 0 ? ' refund' : ''}">${money(e.amount, e.currency)}</div>
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

// Aplica el filtro de categoría del dropdown y re-renderiza (sin refetch).
// cat = '' (Todas) -> null.
function setFilter(cat) {
  activeCat = cat || null
  render(lastData)
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
  activeCat = null
  load()
})
$('#next').addEventListener('click', () => {
  currentMonth = shiftMonth(currentMonth, 1)
  activeCat = null
  load()
})

$('#cat-filter').onchange = (ev) => setFilter(ev.target.value)

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
