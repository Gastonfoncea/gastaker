// src/db.js
import Database from 'better-sqlite3'

// createDb(path) inicializa el esquema y devuelve la API de la base.
// path puede ser ':memory:' (tests) o una ruta a archivo (producción).
export function createDb(path) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_message_id  TEXT    NOT NULL UNIQUE,
      amount            REAL    NOT NULL,
      merchant          TEXT    NOT NULL,
      category          TEXT    NOT NULL,
      card              TEXT,
      occurred_at       TEXT    NOT NULL,
      currency          TEXT    NOT NULL DEFAULT 'ARS',
      source            TEXT    NOT NULL DEFAULT 'santander',
      needs_review      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Migraciones para bases creadas antes de tener estas columnas.
  const cols = sqlite.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name)
  if (!cols.includes('currency')) {
    sqlite.exec("ALTER TABLE expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'ARS'")
  }
  if (!cols.includes('source')) {
    // Las filas existentes son todas de Santander -> se backfillean a 'santander'.
    sqlite.exec("ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT 'santander'")
  }
  if (!cols.includes('needs_review')) {
    sqlite.exec('ALTER TABLE expenses ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0')
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS comercios_conocidos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match       TEXT NOT NULL UNIQUE,
      category    TEXT NOT NULL,
      alias       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Seed idempotente: solo si la tabla está vacía (bases nuevas o migradas).
  // Nombres y colores espejan el CATS histórico del frontend.
  if (sqlite.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const seed = sqlite.prepare('INSERT INTO categories (name, color) VALUES (?, ?)')
    for (const [name, color] of [
      ['Comida', '#FF6B35'],
      ['Supermercado', '#06B6D4'],
      ['Transporte', '#4F46E5'],
      ['Servicios', '#A855F7'],
      ['Suscripciones', '#EC4899'],
      ['Salud', '#10B981'],
      ['Transferencias', '#F59E0B'],
      ['Otros', '#64748B'],
    ]) {
      seed.run(name, color)
    }
  }

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (gmail_message_id, amount, merchant, category, card, occurred_at, currency, source, needs_review)
    VALUES
      (@gmail_message_id, @amount, @merchant, @category, @card, @occurred_at, @currency, @source, @needs_review)
  `)

  const listStmt = sqlite.prepare(`
    SELECT * FROM expenses
    WHERE occurred_at LIKE @prefix
    ORDER BY occurred_at DESC
  `)

  // Error con código, para que las rutas mapeen a status HTTP sin parsear mensajes.
  const fail = (code, message) => {
    const e = new Error(message)
    e.code = code
    throw e
  }
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/

  return {
    // Devuelve { inserted: boolean }. false si el gmail_message_id ya existía.
    insert(record) {
      const info = insertStmt.run({ card: null, currency: 'ARS', source: 'santander', needs_review: 0, ...record })
      return { inserted: info.changes > 0 }
    },
    // month: 'YYYY-MM'. Devuelve las filas de ese mes, más recientes primero.
    list(month) {
      return listStmt.all({ prefix: `${month}%` })
    },
    // Fila completa de un gasto por id, o undefined si no existe.
    getExpense(id) {
      return sqlite.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
    },

    // Resumen del mes: total ARS, total USD, y desglose ARS por categoría (neto > 0).
    resumenMes(month) {
      const rows = listStmt.all({ prefix: `${month}%` })
      let totalArs = 0
      let totalUsd = 0
      const cat = {}
      for (const r of rows) {
        if (r.currency === 'USD') totalUsd += r.amount
        else {
          totalArs += r.amount
          cat[r.category] = (cat[r.category] || 0) + r.amount
        }
      }
      const categoriasArs = {}
      for (const [k, v] of Object.entries(cat)) if (v > 0) categoriasArs[k] = v
      return { month, totalArs, totalUsd, categoriasArs }
    },

    // Lista de movimientos del mes, opcionalmente filtrada (máx 50).
    listarGastos({ month, categoria, comercio }) {
      return listStmt
        .all({ prefix: `${month}%` })
        .filter((r) => (categoria ? r.category === categoria : true))
        .filter((r) => (comercio ? r.merchant.toUpperCase().includes(comercio.toUpperCase()) : true))
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          fecha: r.occurred_at,
          comercio: r.merchant,
          categoria: r.category,
          monto: r.amount,
          moneda: r.currency,
        }))
    },

    compararMeses(mesA, mesB) {
      const tot = (m) => {
        const rows = listStmt.all({ prefix: `${m}%` })
        return {
          totalArs: rows.filter((r) => r.currency !== 'USD').reduce((s, r) => s + r.amount, 0),
          totalUsd: rows.filter((r) => r.currency === 'USD').reduce((s, r) => s + r.amount, 0),
        }
      }
      return { [mesA]: tot(mesA), [mesB]: tot(mesB) }
    },

    pendientes() {
      return sqlite
        .prepare('SELECT * FROM expenses WHERE needs_review = 1 ORDER BY occurred_at DESC LIMIT 50')
        .all()
        .map((r) => ({ id: r.id, fecha: r.occurred_at, comercio: r.merchant, monto: r.amount, moneda: r.currency }))
    },

    // Busca una regla aprendida cuyo `match` esté contenido en el comercio. Devuelve la categoría o null.
    findLearned(merchant) {
      if (!merchant) return null
      const up = merchant.toUpperCase()
      for (const row of sqlite.prepare('SELECT match, category FROM comercios_conocidos').all()) {
        if (up.includes(row.match.toUpperCase())) return row.category
      }
      return null
    },

    clasificarGasto(id, categoria) {
      return (
        sqlite
          .prepare('UPDATE expenses SET category = @categoria, needs_review = 0 WHERE id = @id')
          .run({ id, categoria }).changes > 0
      )
    },

    // Registra un comercio/CUIT aprendido y re-clasifica TODOS los gastos que
    // matcheen (histórico incluido): "registrar" significa que ese comercio ES
    // esa categoría, siempre.
    registrarComercio({ match, categoria, alias = null }) {
      const m = (match || '').trim()
      const BLACKLIST = ['transferencia', 'pago', 'compra', 'consumo', 'debito', 'credito']
      if (m.length < 3 || BLACKLIST.includes(m.toLowerCase())) {
        throw new Error('match inválido: debe ser un identificador específico (no genérico ni < 4 caracteres)')
      }
      sqlite
        .prepare('INSERT OR REPLACE INTO comercios_conocidos (match, category, alias) VALUES (@m, @categoria, @alias)')
        .run({ m, categoria, alias })
      const upd = sqlite
        .prepare("UPDATE expenses SET category = @categoria, needs_review = 0 WHERE upper(merchant) LIKE '%' || upper(@m) || '%'")
        .run({ m, categoria })
      return { inserted: true, actualizados: upd.changes }
    },

    listCategories() {
      return sqlite
        .prepare(`
          SELECT c.id, c.name, c.color,
                 (SELECT COUNT(*) FROM expenses e WHERE e.category = c.name) AS count
          FROM categories c ORDER BY c.id
        `)
        .all()
    },

    createCategory({ name, color }) {
      const n = (name || '').trim()
      if (!n) fail('VALIDATION', 'falta el nombre')
      if (!COLOR_RE.test(color || '')) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
      if (sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(n)) {
        fail('DUP', `ya existe la categoría "${n}"`)
      }
      const info = sqlite.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(n, color)
      return { id: info.lastInsertRowid, name: n, color }
    },

    // Renombrar cascadea por nombre a expenses y comercios_conocidos.
    // "Otros" no se renombra (es el fallback del categorizador y del delete).
    updateCategoryDef(id, { name, color } = {}) {
      const row = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id)
      if (!row) fail('NOT_FOUND', 'categoría no encontrada')
      const newName = name === undefined ? row.name : (name || '').trim()
      const newColor = color === undefined ? row.color : color
      if (!newName) fail('VALIDATION', 'falta el nombre')
      if (!COLOR_RE.test(newColor)) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
      if (row.name === 'Otros' && newName !== 'Otros') fail('PROTECTED', '"Otros" no se puede renombrar')
      if (
        newName.toLowerCase() !== row.name.toLowerCase() &&
        sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE').get(newName)
      ) {
        fail('DUP', `ya existe la categoría "${newName}"`)
      }
      sqlite.transaction(() => {
        if (newName !== row.name) {
          sqlite.prepare('UPDATE expenses SET category = ? WHERE category = ?').run(newName, row.name)
          sqlite.prepare('UPDATE comercios_conocidos SET category = ? WHERE category = ?').run(newName, row.name)
        }
        sqlite.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(newName, newColor, id)
      })()
      return { id, name: newName, color: newColor }
    },

    // Borra la categoría: sus gastos pasan a "Otros" y sus reglas aprendidas se van.
    deleteCategory(id) {
      const row = sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id)
      if (!row) fail('NOT_FOUND', 'categoría no encontrada')
      if (row.name === 'Otros') fail('PROTECTED', '"Otros" no se puede borrar')
      let movidos = 0
      sqlite.transaction(() => {
        movidos = sqlite.prepare("UPDATE expenses SET category = 'Otros' WHERE category = ?").run(row.name).changes
        sqlite.prepare('DELETE FROM comercios_conocidos WHERE category = ?').run(row.name)
        sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id)
      })()
      return { movidos }
    },

    _raw: sqlite,
  }
}
