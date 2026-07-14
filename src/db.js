// src/db.js
import Database from 'better-sqlite3'
import { hashPassword, verifyPassword, randomToken } from './crypto.js'

// Categorías default que se seedean por-usuario al crear cada cuenta.
// Nombres y colores espejan el CATS histórico del frontend.
const DEFAULT_CATEGORIES = [
  ['Comida', '#FF6B35'],
  ['Supermercado', '#06B6D4'],
  ['Transporte', '#4F46E5'],
  ['Servicios', '#A855F7'],
  ['Suscripciones', '#EC4899'],
  ['Salud', '#10B981'],
  ['Transferencias', '#F59E0B'],
  ['Otros', '#64748B'],
]

// Esquema final (multi-user) de las tablas de datos, sin UNIQUE inline: los UNIQUE
// pasan a índices compuestos (user_id, ...) manejables a futuro.
const expensesSchema = (name) => `
  CREATE TABLE ${name} (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER,
    gmail_message_id  TEXT    NOT NULL,
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
`
const comerciosSchema = (name) => `
  CREATE TABLE ${name} (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    match       TEXT NOT NULL,
    category    TEXT NOT NULL,
    alias       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`
const categoriesSchema = (name) => `
  CREATE TABLE ${name} (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    name        TEXT NOT NULL COLLATE NOCASE,
    color       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

// createDb(path) inicializa el esquema y devuelve la API de la base.
// path puede ser ':memory:' (tests) o una ruta a archivo (producción).
export function createDb(path) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')

  // En bases nuevas (:memory: o archivo fresco) estas CREATE arman el esquema
  // final directamente (con user_id). En bases viejas son no-op y la migración
  // de más abajo recrea la tabla con el "12-step dance".
  sqlite.exec(expensesSchema('IF NOT EXISTS expenses'))
  sqlite.exec(comerciosSchema('IF NOT EXISTS comercios_conocidos'))
  sqlite.exec(categoriesSchema('IF NOT EXISTS categories'))

  // --- Migración de expenses a multi-user (idempotente) ---
  const expCols = sqlite.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name)
  if (!expCols.includes('user_id')) {
    // Asegurar primero columnas viejas que puedan faltar, para que el SELECT del copiado
    // siempre las encuentre.
    if (!expCols.includes('currency')) {
      sqlite.exec("ALTER TABLE expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'ARS'")
    }
    if (!expCols.includes('source')) {
      sqlite.exec("ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT 'santander'")
    }
    if (!expCols.includes('needs_review')) {
      sqlite.exec('ALTER TABLE expenses ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0')
    }
    sqlite.pragma('foreign_keys = OFF')
    sqlite.transaction(() => {
      sqlite.exec(expensesSchema('expenses_new'))
      // Backfill user_id = NULL: las filas viejas quedan huérfanas (invisibles vía
      // forUser) hasta que el bootstrap les asigne dueño.
      sqlite.exec(`
        INSERT INTO expenses_new
          (id, user_id, gmail_message_id, amount, merchant, category, card, occurred_at, currency, source, needs_review, created_at)
        SELECT id, NULL, gmail_message_id, amount, merchant, category, card, occurred_at, currency, source, needs_review, created_at
        FROM expenses
      `)
      sqlite.exec('DROP TABLE expenses')
      sqlite.exec('ALTER TABLE expenses_new RENAME TO expenses')
    })()
    sqlite.pragma('foreign_keys = ON')
  }

  // --- Migración de comercios_conocidos ---
  const comCols = sqlite.prepare('PRAGMA table_info(comercios_conocidos)').all().map((c) => c.name)
  if (!comCols.includes('user_id')) {
    sqlite.pragma('foreign_keys = OFF')
    sqlite.transaction(() => {
      sqlite.exec(comerciosSchema('comercios_new'))
      sqlite.exec(`
        INSERT INTO comercios_new (id, user_id, match, category, alias, created_at)
        SELECT id, NULL, match, category, alias, created_at FROM comercios_conocidos
      `)
      sqlite.exec('DROP TABLE comercios_conocidos')
      sqlite.exec('ALTER TABLE comercios_new RENAME TO comercios_conocidos')
    })()
    sqlite.pragma('foreign_keys = ON')
  }

  // --- Migración de categories (sin seed global: el seed pasa a ser por-usuario) ---
  const catCols = sqlite.prepare('PRAGMA table_info(categories)').all().map((c) => c.name)
  if (!catCols.includes('user_id')) {
    sqlite.pragma('foreign_keys = OFF')
    sqlite.transaction(() => {
      sqlite.exec(categoriesSchema('categories_new'))
      sqlite.exec(`
        INSERT INTO categories_new (id, user_id, name, color, created_at)
        SELECT id, NULL, name, color, created_at FROM categories
      `)
      sqlite.exec('DROP TABLE categories')
      sqlite.exec('ALTER TABLE categories_new RENAME TO categories')
    })()
    sqlite.pragma('foreign_keys = ON')
  }

  // Índices UNIQUE compuestos (idempotentes).
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_user_msg ON expenses(user_id, gmail_message_id)')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_comercios_user_match ON comercios_conocidos(user_id, match)')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_user_name ON categories(user_id, name)')

  // --- Tablas de auth multi-usuario ---
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

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (user_id, gmail_message_id, amount, merchant, category, card, occurred_at, currency, source, needs_review)
    VALUES
      (@user_id, @gmail_message_id, @amount, @merchant, @category, @card, @occurred_at, @currency, @source, @needs_review)
  `)

  const listStmt = sqlite.prepare(`
    SELECT * FROM expenses
    WHERE user_id = @user_id AND occurred_at LIKE @prefix
    ORDER BY occurred_at DESC
  `)

  const seedCategoryStmt = sqlite.prepare('INSERT INTO categories (user_id, name, color) VALUES (?, ?, ?)')

  // Error con código, para que las rutas mapeen a status HTTP sin parsear mensajes.
  const fail = (code, message) => {
    const e = new Error(message)
    e.code = code
    throw e
  }
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/

  // forUser(userId): la API de datos con user_id fijado en todas las queries.
  // Expone exactamente la superficie histórica de la db (misma firma).
  function forUser(userId) {
    return {
      // Devuelve { inserted: boolean }. false si el (user_id, gmail_message_id) ya existía.
      insert(record) {
        const info = insertStmt.run({
          user_id: userId,
          card: null,
          currency: 'ARS',
          source: 'santander',
          needs_review: 0,
          ...record,
        })
        return { inserted: info.changes > 0 }
      },
      // month: 'YYYY-MM'. Devuelve las filas de ese mes, más recientes primero.
      list(month) {
        return listStmt.all({ user_id: userId, prefix: `${month}%` })
      },
      // Fila completa de un gasto por id (scopeado), o undefined si no es de este user.
      getExpense(id) {
        return sqlite.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, userId)
      },

      // Resumen del mes: total ARS, total USD, y desglose ARS por categoría (neto > 0).
      resumenMes(month) {
        const rows = listStmt.all({ user_id: userId, prefix: `${month}%` })
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
          .all({ user_id: userId, prefix: `${month}%` })
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
          const rows = listStmt.all({ user_id: userId, prefix: `${m}%` })
          return {
            totalArs: rows.filter((r) => r.currency !== 'USD').reduce((s, r) => s + r.amount, 0),
            totalUsd: rows.filter((r) => r.currency === 'USD').reduce((s, r) => s + r.amount, 0),
          }
        }
        return { [mesA]: tot(mesA), [mesB]: tot(mesB) }
      },

      pendientes() {
        return sqlite
          .prepare('SELECT * FROM expenses WHERE needs_review = 1 AND user_id = ? ORDER BY occurred_at DESC LIMIT 50')
          .all(userId)
          .map((r) => ({ id: r.id, fecha: r.occurred_at, comercio: r.merchant, monto: r.amount, moneda: r.currency }))
      },

      // Busca una regla aprendida (de este user) cuyo `match` esté contenido en el comercio.
      findLearned(merchant) {
        if (!merchant) return null
        const up = merchant.toUpperCase()
        for (const row of sqlite.prepare('SELECT match, category FROM comercios_conocidos WHERE user_id = ?').all(userId)) {
          if (up.includes(row.match.toUpperCase())) return row.category
        }
        return null
      },

      clasificarGasto(id, categoria) {
        return (
          sqlite
            .prepare('UPDATE expenses SET category = @categoria, needs_review = 0 WHERE id = @id AND user_id = @user_id')
            .run({ id, categoria, user_id: userId }).changes > 0
        )
      },

      // Registra un comercio aprendido (de este user) y re-clasifica TODOS sus gastos
      // que matcheen (histórico incluido).
      registrarComercio({ match, categoria, alias = null }) {
        const m = (match || '').trim()
        const BLACKLIST = ['transferencia', 'pago', 'compra', 'consumo', 'debito', 'credito']
        if (m.length < 3 || BLACKLIST.includes(m.toLowerCase())) {
          throw new Error('match inválido: debe ser un identificador específico (no genérico ni < 4 caracteres)')
        }
        sqlite
          .prepare('INSERT OR REPLACE INTO comercios_conocidos (user_id, match, category, alias) VALUES (@user_id, @m, @categoria, @alias)')
          .run({ user_id: userId, m, categoria, alias })
        const upd = sqlite
          .prepare("UPDATE expenses SET category = @categoria, needs_review = 0 WHERE upper(merchant) LIKE '%' || upper(@m) || '%' AND user_id = @user_id")
          .run({ user_id: userId, m, categoria })
        return { inserted: true, actualizados: upd.changes }
      },

      listCategories() {
        return sqlite
          .prepare(`
            SELECT c.id, c.name, c.color,
                   (SELECT COUNT(*) FROM expenses e WHERE e.category = c.name AND e.user_id = @user_id) AS count
            FROM categories c WHERE c.user_id = @user_id ORDER BY c.id
          `)
          .all({ user_id: userId })
      },

      createCategory({ name, color }) {
        const n = (name || '').trim()
        if (!n) fail('VALIDATION', 'falta el nombre')
        if (!COLOR_RE.test(color || '')) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
        if (sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND user_id = ?').get(n, userId)) {
          fail('DUP', `ya existe la categoría "${n}"`)
        }
        const info = sqlite.prepare('INSERT INTO categories (user_id, name, color) VALUES (?, ?, ?)').run(userId, n, color)
        return { id: info.lastInsertRowid, name: n, color }
      },

      // Renombrar cascadea por nombre (scopeado al user) a expenses y comercios_conocidos.
      updateCategoryDef(id, { name, color } = {}) {
        const row = sqlite.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId)
        if (!row) fail('NOT_FOUND', 'categoría no encontrada')
        const newName = name === undefined ? row.name : (name || '').trim()
        const newColor = color === undefined ? row.color : color
        if (!newName) fail('VALIDATION', 'falta el nombre')
        if (!COLOR_RE.test(newColor)) fail('VALIDATION', 'color inválido (formato #RRGGBB)')
        if (row.name === 'Otros' && newName !== 'Otros') fail('PROTECTED', '"Otros" no se puede renombrar')
        if (
          newName.toLowerCase() !== row.name.toLowerCase() &&
          sqlite.prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND user_id = ?').get(newName, userId)
        ) {
          fail('DUP', `ya existe la categoría "${newName}"`)
        }
        sqlite.transaction(() => {
          if (newName !== row.name) {
            sqlite.prepare('UPDATE expenses SET category = ? WHERE category = ? AND user_id = ?').run(newName, row.name, userId)
            sqlite.prepare('UPDATE comercios_conocidos SET category = ? WHERE category = ? AND user_id = ?').run(newName, row.name, userId)
          }
          sqlite.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ? AND user_id = ?').run(newName, newColor, id, userId)
        })()
        return { id, name: newName, color: newColor }
      },

      // Borra la categoría: sus gastos pasan a "Otros" y sus reglas aprendidas se van (todo scopeado).
      deleteCategory(id) {
        const row = sqlite.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId)
        if (!row) fail('NOT_FOUND', 'categoría no encontrada')
        if (row.name === 'Otros') fail('PROTECTED', '"Otros" no se puede borrar')
        let movidos = 0
        sqlite.transaction(() => {
          movidos = sqlite
            .prepare("UPDATE expenses SET category = 'Otros' WHERE category = ? AND user_id = ?")
            .run(row.name, userId).changes
          sqlite.prepare('DELETE FROM comercios_conocidos WHERE category = ? AND user_id = ?').run(row.name, userId)
          sqlite.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(id, userId)
        })()
        return { movidos }
      },
    }
  }

  return {
    forUser,

    // --- Usuarios / auth / sesiones / invites (nivel raíz, no scopeadas) ---

    // Crea un usuario (hashea la password, genera ingest_token, seedea sus 8 categorías
    // default). isAdmin=true solo para el bootstrap. Lanza DUP si el email (o el
    // whatsapp_number) ya existe.
    createUser({ email, password, whatsappNumber = null, isAdmin = false } = {}) {
      const e = (email || '').trim()
      if (!e) fail('VALIDATION', 'falta el email')
      if (!password) fail('VALIDATION', 'falta la password')
      const wn = whatsappNumber ? String(whatsappNumber).trim() : null
      const passwordHash = hashPassword(password)
      const ingestToken = randomToken(24)
      let userId
      try {
        sqlite.transaction(() => {
          const info = sqlite
            .prepare('INSERT INTO users (email, password_hash, ingest_token, whatsapp_number, is_admin) VALUES (?, ?, ?, ?, ?)')
            .run(e, passwordHash, ingestToken, wn || null, isAdmin ? 1 : 0)
          userId = info.lastInsertRowid
          for (const [name, color] of DEFAULT_CATEGORIES) seedCategoryStmt.run(userId, name, color)
        })()
      } catch (err) {
        if (String(err.code || '').includes('CONSTRAINT')) {
          if (String(err.message).includes('users.whatsapp_number')) fail('DUP', 'ese número ya está en uso')
          fail('DUP', `ya existe un usuario con el email "${e}"`)
        }
        throw err
      }
      return { id: userId, email: e, ingest_token: ingestToken, whatsapp_number: wn || null, is_admin: isAdmin ? 1 : 0 }
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
      if (!token) return { valid: false, reason: 'not_found' }
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
      if (!token) fail('INVITE_INVALID', 'invitación inexistente')
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
