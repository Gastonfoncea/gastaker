/* gastaker — gestión de categorías (crear / renombrar / borrar). */

const $ = (s) => document.querySelector(s)

// Paleta preset para elegir color (los 8 seed + 4 extra).
const PALETTE = [
  '#FF6B35', '#06B6D4', '#4F46E5', '#A855F7', '#EC4899', '#10B981',
  '#F59E0B', '#64748B', '#EF4444', '#84CC16', '#14B8A6', '#8B5CF6',
]
let selectedColor = PALETTE[0]
let cats = []
let editingColorId = null // id de la categoría cuya paleta de edición de color está abierta

function escape(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (res.status === 401) {
    location.href = '/' // sin sesión: al home a loguear
    throw new Error('sin sesión')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'error')
  return body
}

async function load() {
  const data = await api('/api/categories')
  cats = data.categories
  render()
}

function render() {
  renderPalette()
  $('#cats').innerHTML = cats
    .map((c) => {
      const protegida = c.name === 'Otros'
      // Toggle "no suma al total": disponible en todas (también en Otros).
      const sumToggle = `<button class="cat-action" data-act="sum" data-id="${c.id}">${c.excluded ? 'Sumar' : 'No sumar'}</button>`
      const acciones = protegida
        ? `<button class="cat-action" data-act="color" data-id="${c.id}">Color</button>
           ${sumToggle}
           <span class="cat-lock" title="Categoría fija">fija</span>`
        : `<button class="cat-action" data-act="color" data-id="${c.id}">Color</button>
           ${sumToggle}
           <button class="cat-action" data-act="rename" data-id="${c.id}">Renombrar</button>
           <button class="cat-action danger" data-act="delete" data-id="${c.id}">Borrar</button>`
      const colorPicker =
        editingColorId === c.id
          ? `<div class="cat-color-picker">${PALETTE.map(
              (color) =>
                `<button type="button" class="swatch${color === c.color ? ' sel' : ''}"
                  style="background:${color}" data-color="${color}" data-id="${c.id}" aria-label="${color}"></button>`
            ).join('')}</div>`
          : ''
      return `<div class="cat-row">
        <span class="dot" style="background:${c.color}"></span>
        <span class="cat-name">${escape(c.name)}</span>
        ${c.excluded ? '<span class="cat-nosum" title="No suma al total del mes">no suma</span>' : ''}
        <span class="cat-count">${c.count} ${c.count === 1 ? 'gasto' : 'gastos'}</span>
        ${acciones}
        ${colorPicker}
      </div>`
    })
    .join('')

  $('#cats').querySelectorAll('.cat-action').forEach((b) => {
    const cat = cats.find((c) => c.id === Number(b.dataset.id))
    b.addEventListener('click', () => {
      if (b.dataset.act === 'rename') return rename(cat)
      if (b.dataset.act === 'delete') return remove(cat)
      if (b.dataset.act === 'sum') return toggleSum(cat)
      if (b.dataset.act === 'color') {
        editingColorId = editingColorId === cat.id ? null : cat.id
        render()
      }
    })
  })

  $('#cats').querySelectorAll('.cat-color-picker .swatch').forEach((s) => {
    s.addEventListener('click', () => recolor(Number(s.dataset.id), s.dataset.color))
  })
}

function renderPalette() {
  $('#palette').innerHTML = PALETTE.map(
    (color) => `<button type="button" class="swatch${color === selectedColor ? ' sel' : ''}"
      style="background:${color}" data-color="${color}" aria-label="${color}"></button>`
  ).join('')
  $('#palette').querySelectorAll('.swatch').forEach((s) => {
    s.addEventListener('click', () => {
      selectedColor = s.dataset.color
      renderPalette()
    })
  })
}

async function rename(cat) {
  const nuevo = prompt(`Renombrar "${cat.name}" a:`, cat.name)
  if (!nuevo || nuevo.trim() === cat.name) return
  try {
    await api(`/api/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ name: nuevo.trim() }) })
    load()
  } catch (e) {
    alert(e.message)
  }
}

// Togglea si la categoría suma o no al total del mes (excluded).
async function toggleSum(cat) {
  try {
    await api(`/api/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ excluded: !cat.excluded }) })
    load()
  } catch (e) {
    alert(e.message)
  }
}

async function recolor(id, color) {
  editingColorId = null
  try {
    await api(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify({ color }) })
    load()
  } catch (e) {
    alert(e.message)
  }
}

async function remove(cat) {
  const msg = cat.count
    ? `${cat.count} ${cat.count === 1 ? 'gasto va' : 'gastos van'} a pasar a "Otros". ¿Borrar "${cat.name}"?`
    : `¿Borrar "${cat.name}"?`
  if (!confirm(msg)) return
  try {
    await api(`/api/categories/${cat.id}`, { method: 'DELETE' })
    load()
  } catch (e) {
    alert(e.message)
  }
}

$('#new-cat').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const errEl = $('#form-error')
  errEl.classList.add('hidden')
  try {
    await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: $('#new-name').value, color: selectedColor }),
    })
    $('#new-name').value = ''
    load()
  } catch (e) {
    errEl.textContent = e.message
    errEl.classList.remove('hidden')
  }
})

load()
