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

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (gmail_message_id, amount, merchant, category, card, occurred_at, currency, source)
    VALUES
      (@gmail_message_id, @amount, @merchant, @category, @card, @occurred_at, @currency, @source)
  `)

  const listStmt = sqlite.prepare(`
    SELECT * FROM expenses
    WHERE occurred_at LIKE @prefix
    ORDER BY occurred_at DESC
  `)

  const updateStmt = sqlite.prepare(`
    UPDATE expenses SET category = @category WHERE id = @id
  `)

  return {
    // Devuelve { inserted: boolean }. false si el gmail_message_id ya existía.
    insert(record) {
      const info = insertStmt.run({ card: null, currency: 'ARS', source: 'santander', ...record })
      return { inserted: info.changes > 0 }
    },
    // month: 'YYYY-MM'. Devuelve las filas de ese mes, más recientes primero.
    list(month) {
      return listStmt.all({ prefix: `${month}%` })
    },
    // Devuelve true si actualizó alguna fila.
    updateCategory(id, category) {
      return updateStmt.run({ id, category }).changes > 0
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
      return [] // reemplazado en Task 7 (Fase 2)
    },

    _raw: sqlite,
  }
}
