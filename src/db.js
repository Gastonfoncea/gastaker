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
    _raw: sqlite,
  }
}
