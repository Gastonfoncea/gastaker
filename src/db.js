// src/db.js
import Database from 'better-sqlite3'
import { hashPassword, verifyPassword, randomToken } from './crypto.js'

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

  // --- Tablas de auth multi-usuario (aditivas; no tocan las tablas de datos) ---
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash   TEXT    NOT NULL,           -- "scrypt$<saltHex>$<hashHex>"
      ingest_token    TEXT    NOT NULL UNIQUE,    -- randomToken(24), para el Apps Script
      whatsapp_number TEXT    UNIQUE,             -- nullable; internacional sin '+'
      is_admin        INTEGER NOT NULL DEFAULT 0, -- 1 = puede generar invitaciones
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT    PRIMARY KEY,            -- randomToken(32)
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  TEXT    NOT NULL,               -- now + 30 días
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invites (
      token       TEXT    PRIMARY KEY,            -- randomToken(24)
      created_by  INTEGER NOT NULL REFERENCES users(id),
      used_by     INTEGER REFERENCES users(id),   -- NULL = sin usar
      expires_at  TEXT    NOT NULL,               -- now + 7 días
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
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

    // --- Usuarios / auth / sesiones / invites (nivel raíz, no scopeadas) ---

    // Crea un usuario (hashea la password, genera ingest_token). isAdmin=true solo
    // para el bootstrap. Lanza DUP si el email (o el whatsapp_number) ya existe.
    // Nota: el seed de categorías por-usuario se agrega en la etapa de scoping.
    createUser({ email, password, whatsappNumber = null, isAdmin = false } = {}) {
      const e = (email || '').trim()
      if (!e) fail('VALIDATION', 'falta el email')
      if (!password) fail('VALIDATION', 'falta la password')
      const wn = whatsappNumber ? String(whatsappNumber).trim() : null
      const passwordHash = hashPassword(password)
      const ingestToken = randomToken(24)
      let info
      try {
        info = sqlite
          .prepare(
            'INSERT INTO users (email, password_hash, ingest_token, whatsapp_number, is_admin) VALUES (?, ?, ?, ?, ?)'
          )
          .run(e, passwordHash, ingestToken, wn || null, isAdmin ? 1 : 0)
      } catch (err) {
        if (String(err.code || '').includes('CONSTRAINT')) {
          if (String(err.message).includes('users.whatsapp_number')) fail('DUP', 'ese número ya está en uso')
          fail('DUP', `ya existe un usuario con el email "${e}"`)
        }
        throw err
      }
      return { id: info.lastInsertRowid, email: e, ingest_token: ingestToken, whatsapp_number: wn || null, is_admin: isAdmin ? 1 : 0 }
    },

    // Devuelve la fila del usuario si email+password validan; si no, null.
    authenticate(email, password) {
      const row = sqlite.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get((email || '').trim())
      if (!row) return null
      return verifyPassword(password, row.password_hash) ? row : null
    },

    getUserById(id) {
      return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id)
    },
    getUserByEmail(email) {
      return sqlite.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get((email || '').trim())
    },
    getUserByIngestToken(token) {
      if (!token) return undefined
      return sqlite.prepare('SELECT * FROM users WHERE ingest_token = ?').get(token)
    },
    // Nunca matchea NULL/vacío: un número no registrado no resuelve a ningún user.
    getUserByWhatsappNumber(number) {
      const n = number == null ? '' : String(number).trim()
      if (!n) return undefined
      return sqlite.prepare('SELECT * FROM users WHERE whatsapp_number = ?').get(n)
    },

    // Actualiza el whatsapp_number (nullable). Lanza DUP si ya está en otro user.
    updateUser(id, { whatsappNumber } = {}) {
      const wn = whatsappNumber == null || String(whatsappNumber).trim() === '' ? null : String(whatsappNumber).trim()
      try {
        sqlite.prepare('UPDATE users SET whatsapp_number = ? WHERE id = ?').run(wn, id)
      } catch (err) {
        if (String(err.code || '').includes('CONSTRAINT')) fail('DUP', 'ese número ya está en uso')
        throw err
      }
      return { whatsapp_number: wn }
    },

    createSession(userId) {
      const token = randomToken(32)
      sqlite
        .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
        .run(token, userId)
      const row = sqlite.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token)
      return { token, expires_at: row.expires_at }
    },

    // Devuelve { user_id, expires_at } si la sesión está vigente, o null.
    // Limpieza oportunista: borra todas las sesiones vencidas en cada llamada.
    getSession(token) {
      if (!token) return null
      sqlite.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run()
      return sqlite.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) || null
    },

    deleteSession(token) {
      if (!token) return
      sqlite.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    },

    createInvite(createdBy) {
      const token = randomToken(24)
      sqlite
        .prepare("INSERT INTO invites (token, created_by, expires_at) VALUES (?, ?, datetime('now', '+7 days'))")
        .run(token, createdBy)
      const row = sqlite.prepare('SELECT expires_at FROM invites WHERE token = ?').get(token)
      return { token, expires_at: row.expires_at }
    },

    // { valid:true } o { valid:false, reason: 'not_found'|'used'|'expired' }.
    getInvite(token) {
      const row = sqlite
        .prepare("SELECT used_by, (expires_at < datetime('now')) AS expired FROM invites WHERE token = ?")
        .get(token)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.used_by != null) return { valid: false, reason: 'used' }
      if (row.expired) return { valid: false, reason: 'expired' }
      return { valid: true }
    },

    // Marca el invite como usado. Lanza INVITE_INVALID si no existe / ya usado / vencido.
    useInvite(token, userId) {
      sqlite.transaction(() => {
        const row = sqlite
          .prepare("SELECT used_by, (expires_at < datetime('now')) AS expired FROM invites WHERE token = ?")
          .get(token)
        if (!row) fail('INVITE_INVALID', 'invitación inexistente')
        if (row.used_by != null) fail('INVITE_INVALID', 'invitación ya usada')
        if (row.expired) fail('INVITE_INVALID', 'invitación vencida')
        sqlite.prepare('UPDATE invites SET used_by = ? WHERE token = ?').run(userId, token)
      })()
    },

    _raw: sqlite,
  }
}
