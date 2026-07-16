/* gastaker — frontend (vanilla). Ledger view, month stepper, inline recat. */

// Las categorías (nombre + color) viven en la DB y se cargan por API.
let CATS = []
let COLOR = {}
let EXCLUDED = new Set() // categorías que no suman al total (ej: Movimientos internos)
const colorOf = (name) => COLOR[name] || '#71717a'

async function loadCategories() {
  const res = await fetch('/api/categories')
  if (!res.ok) return
  const data = await res.json()
  CATS = data.categories
  COLOR = Object.fromEntries(CATS.map((c) => [c.name, c.color]))
  EXCLUDED = new Set(CATS.filter((c) => c.excluded).map((c) => c.name))
}

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
  await loadCategories()
  const data = await res.json()
  lastData = data
  showApp()
  $('#month-label').textContent = monthLabel(currentMonth)
  render(data)
}

function render({ expenses }) {
  // Pesos y dólares no se suman: el total grande es en pesos, el USD va aparte.
  // Las categorías excluidas (EXCLUDED) se ven en la lista pero no suman a nada.
  // Los consumos con crédito tampoco suman: se debitan el mes siguiente y van
  // en su propia línea ("Tarjeta"), como los USD.
  const noSuma = (e) => EXCLUDED.has(e.category)
  const esCredito = (e) => e.payment_method === 'Crédito'
  const esArs = (e) => (e.currency || 'ARS') === 'ARS'
  // Un gasto no suma a nada si su categoría está excluida, o si es un consumo
  // con crédito EN PESOS (esos van a la línea Tarjeta). Un consumo con crédito
  // en USD sí suma: la línea USD los cuenta igual, sin importar el medio de pago.
  const noSumaFila = (e) => noSuma(e) || (esCredito(e) && esArs(e))
  const ars = expenses.filter(esArs)
  const usd = expenses.filter((e) => e.currency === 'USD')
  const arsTotal = ars.filter((e) => !noSuma(e) && !esCredito(e)).reduce((s, e) => s + e.amount, 0)
  const usdTotal = usd.filter((e) => !noSuma(e)).reduce((s, e) => s + e.amount, 0)
  const tarjetaTotal = ars.filter((e) => !noSuma(e) && esCredito(e)).reduce((s, e) => s + e.amount, 0)

  $('#total').innerHTML = arsTotal ? money(arsTotal, 'ARS') : '<span class="muted">$0</span>'

  const usdEl = $('#total-usd')
  if (usdTotal > 0) {
    usdEl.innerHTML = money(usdTotal, 'USD')
    usdEl.classList.remove('hidden')
  } else {
    usdEl.classList.add('hidden')
  }

  const tarjetaEl = $('#total-tarjeta')
  if (tarjetaTotal > 0) {
    tarjetaEl.innerHTML = `Tarjeta: ${money(tarjetaTotal, 'ARS')}`
    tarjetaEl.classList.remove('hidden')
  } else {
    tarjetaEl.classList.add('hidden')
  }

  // barra de proporción + leyenda: solo pesos, y solo categorías con neto > 0
  // (las anulaciones restan, así que una categoría puede netear a 0 y no se muestra)
  const totals = {}
  for (const e of ars) {
    if (noSuma(e) || esCredito(e)) continue
    totals[e.category] = (totals[e.category] || 0) + e.amount
  }
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
          const credito = esCredito(e) ? '<span class="row-credito">crédito</span>' : ''
          return `<div class="row${noSumaFila(e) ? ' excluded' : ''}" style="animation-delay:${Math.min(i * 22, 260)}ms">
            <div class="cell-date"><span class="d-day">${day}</span><span class="d-time">${time}</span></div>
            <div class="cell-merchant">
              <span class="row-merchant">${escape(e.merchant)}</span>${card}${credito}
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
  mainMenu.classList.add('hidden') // si el hamburguesa estaba abierto, no lo dejamos detrás del popover
  menu.innerHTML = CATS.map(
    (c) => `<button data-name="${c.name}" aria-current="${c.name === current}">
      <span class="dot" style="background:${c.color}"></span>${c.name}
      <span class="check">✓</span>
    </button>`
  ).join('')
  positionMenu(anchor)

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const name = b.dataset.name
      if (name === current) return closeMenu()
      openScopeStep(anchor, id, name)
    })
  })
}

// Paso 2: elegir alcance. "Solo este gasto" = PATCH normal; "Siempre este
// comercio" = learn:true (aprende la regla y pisa el histórico del comercio).
function openScopeStep(anchor, id, category) {
  const exp = lastData.expenses.find((e) => e.id === id)
  const merchant = exp ? exp.merchant : ''
  menu.innerHTML = `
    <div class="scope-head">${escape(merchant)} → <span class="scope-cat" style="color:${colorOf(category)}">${category}</span></div>
    <button data-scope="one">Solo este gasto</button>
    <button data-scope="always">Siempre este comercio</button>
  `
  positionMenu(anchor)

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const learn = b.dataset.scope === 'always'
      closeMenu()
      const res = await fetch(`/api/expenses/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(learn ? { category, learn: true } : { category }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || 'No se pudo guardar')
      }
      load()
    })
  })
}

// Posiciona el popover pegado al anchor; si no entra abajo, abre hacia arriba.
function positionMenu(anchor) {
  const r = anchor.getBoundingClientRect()
  menu.classList.remove('hidden')
  const mh = menu.offsetHeight
  const below = r.bottom + 6
  const top = below + mh > window.innerHeight ? r.top - mh - 6 : below
  menu.style.top = `${Math.max(8, top)}px`
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`
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
  $('#email')?.focus()
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

// menú hamburguesa
const menuBtn = $('#menu-btn')
const mainMenu = $('#mainmenu')
menuBtn.addEventListener('click', (ev) => {
  ev.stopPropagation()
  const open = mainMenu.classList.toggle('hidden')
  menuBtn.setAttribute('aria-expanded', String(!open))
})
document.addEventListener('click', () => mainMenu.classList.add('hidden'))

/* Auto-refresh al volver a la app: entrás (volvés a la pestaña o a la ventana)
   y se actualiza sola, sin polling. Preserva el mes y el filtro activo. */
let lastRefresh = 0
function refreshOnReturn() {
  if ($('#app').classList.contains('hidden')) return // no logueado: nada que refrescar
  const now = Date.now()
  if (now - lastRefresh < 1500) return // evita doble disparo (visibility + focus)
  lastRefresh = now
  load()
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnReturn()
})
window.addEventListener('focus', refreshOnReturn)

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }),
  })
  if (res.ok) {
    $('#login-error').classList.add('hidden')
    load()
  } else {
    $('#login-error').classList.remove('hidden')
    $('#password').value = ''
  }
})

// Salir: cierra la sesión en el server y vuelve al login.
$('#logout').addEventListener('click', async (ev) => {
  ev.preventDefault()
  await fetch('/api/logout', { method: 'POST' })
  showLogin()
})

load()
