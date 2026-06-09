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
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO expenses
      (gmail_message_id, amount, merchant, category, card, occurred_at)
    VALUES
      (@gmail_message_id, @amount, @merchant, @category, @card, @occurred_at)
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
      const info = insertStmt.run({ card: null, ...record })
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
