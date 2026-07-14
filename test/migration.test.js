// test/migration.test.js — migración de una DB con el esquema VIEJO (single-user)
// al esquema multi-user, + adopción de datos huérfanos (lógica del bootstrap).
// Se usa un archivo temporal porque :memory: no persiste entre conexiones y el
// esquema viejo hay que crearlo en una conexión previa.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDb } from '../src/db.js'

let dbPath
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix
    if (existsSync(f)) unlinkSync(f)
  }
}

// Crea una DB con el esquema single-user original (UNIQUE inline, sin user_id).
function seedOldSchemaDb(path) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(`
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_message_id TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      merchant TEXT NOT NULL,
      category TEXT NOT NULL,
      card TEXT,
      occurred_at TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ARS',
      source TEXT NOT NULL DEFAULT 'santander',
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE comercios_conocidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      alias TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  sqlite.prepare('INSERT INTO expenses (gmail_message_id, amount, merchant, category, occurred_at) VALUES (?, ?, ?, ?, ?)')
    .run('viejo-1', 100, 'VERDULERIA KATIE', 'Comida', '2026-06-01T10:00:00')
  sqlite.prepare('INSERT INTO expenses (gmail_message_id, amount, merchant, category, occurred_at) VALUES (?, ?, ?, ?, ?)')
    .run('viejo-2', 200, 'UBER', 'Transporte', '2026-06-02T10:00:00')
  sqlite.prepare('INSERT INTO comercios_conocidos (match, category) VALUES (?, ?)').run('UBER', 'Transporte')
  // Seed viejo (8 default) + una categoría custom.
  for (const [n, c] of [['Comida', '#FF6B35'], ['Supermercado', '#06B6D4'], ['Transporte', '#4F46E5'],
    ['Servicios', '#A855F7'], ['Suscripciones', '#EC4899'], ['Salud', '#10B981'],
    ['Transferencias', '#F59E0B'], ['Otros', '#64748B'], ['Mascotas', '#22C55E']]) {
    sqlite.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(n, c)
  }
  sqlite.close()
}

describe('migración de esquema viejo a multi-user', () => {
  beforeEach(() => {
    dbPath = join(tmpdir(), `gastaker-migration-${process.pid}-${Date.now()}.db`)
    cleanup()
    seedOldSchemaDb(dbPath)
  })
  afterEach(cleanup)

  it('createDb agrega user_id y los índices compuestos, conservando los datos', () => {
    const db = createDb(dbPath)
    const raw = db._raw

    // user_id ahora existe en las tres tablas.
    for (const t of ['expenses', 'comercios_conocidos', 'categories']) {
      const cols = raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      expect(cols).toContain('user_id')
    }
    // Índices UNIQUE compuestos creados.
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name)
    expect(idx).toContain('ux_expenses_user_msg')
    expect(idx).toContain('ux_comercios_user_match')
    expect(idx).toContain('ux_categories_user_name')

    // Los datos siguen ahí, con user_id NULL (huérfanos).
    expect(raw.prepare('SELECT COUNT(*) n FROM expenses').get().n).toBe(2)
    expect(raw.prepare('SELECT COUNT(*) n FROM expenses WHERE user_id IS NULL').get().n).toBe(2)
    expect(raw.prepare('SELECT COUNT(*) n FROM categories WHERE user_id IS NULL').get().n).toBe(9)
  })

  it('los datos huérfanos son invisibles vía forUser hasta adoptarlos', () => {
    const db = createDb(dbPath)
    const user = db.createUser({ email: 'gaston@test.com', password: 'x', isAdmin: true })
    // El seed de createUser dio 8 categorías propias; los 2 gastos viejos NO se ven.
    expect(db.forUser(user.id).list('2026-06')).toHaveLength(0)
    expect(db.forUser(user.id).listCategories()).toHaveLength(8)
  })

  it('la lógica de bootstrap adopta gastos/comercios y la categoría custom', () => {
    const db = createDb(dbPath)
    const raw = db._raw
    const user = db.createUser({ email: 'gaston@test.com', password: 'x', isAdmin: true })

    // --- Réplica de la adopción del script bootstrap-user.js ---
    raw.transaction(() => {
      raw.prepare('UPDATE expenses SET user_id = ? WHERE user_id IS NULL').run(user.id)
      raw.prepare('UPDATE comercios_conocidos SET user_id = ? WHERE user_id IS NULL').run(user.id)
      for (const c of raw.prepare('SELECT id, name FROM categories WHERE user_id IS NULL').all()) {
        const yaExiste = raw.prepare('SELECT 1 FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, c.name)
        if (yaExiste) raw.prepare('DELETE FROM categories WHERE id = ?').run(c.id)
        else raw.prepare('UPDATE categories SET user_id = ? WHERE id = ?').run(user.id, c.id)
      }
    })()

    const udb = db.forUser(user.id)
    // Ahora los 2 gastos se ven y la regla aprendida también.
    expect(udb.list('2026-06')).toHaveLength(2)
    expect(udb.findLearned('PAYU UBER 123')).toBe('Transporte')
    // Las 8 default seedeadas + la custom "Mascotas" adoptada = 9; sin duplicar las default.
    const cats = udb.listCategories()
    expect(cats).toHaveLength(9)
    expect(cats.filter((c) => c.name === 'Comida')).toHaveLength(1)
    expect(cats.some((c) => c.name === 'Mascotas')).toBe(true)
  })
})
