// test/excluded-categories.test.js — categorías con "no suma al total" (excluded).
// Caso de uso: transferencias internas (plata entre cuentas propias) no son gasto.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDb } from '../src/db.js'
import { makeUserDb, makeAppWithUser, authedAgent } from './helpers.js'

const gasto = (over = {}) => ({
  gmail_message_id: `m-${Math.random()}`,
  amount: 100,
  merchant: 'X',
  category: 'Comida',
  occurred_at: '2026-07-01T10:00:00',
  ...over,
})

describe('seed y CRUD del flag excluded', () => {
  it('el seed incluye "Movimientos internos" con excluded=1 y el resto con 0', () => {
    const { udb } = makeUserDb()
    const cats = udb.listCategories()
    const internos = cats.find((c) => c.name === 'Movimientos internos')
    expect(internos).toBeDefined()
    expect(internos.excluded).toBe(1)
    expect(cats.find((c) => c.name === 'Comida').excluded).toBe(0)
  })

  it('createCategory acepta excluded y updateCategoryDef lo togglea', () => {
    const { udb } = makeUserDb()
    const nueva = udb.createCategory({ name: 'Ahorro', color: '#10B981', excluded: true })
    expect(udb.listCategories().find((c) => c.id === nueva.id).excluded).toBe(1)

    // Toggle a 0 sin tocar nombre/color.
    udb.updateCategoryDef(nueva.id, { excluded: false })
    const row = udb.listCategories().find((c) => c.id === nueva.id)
    expect(row.excluded).toBe(0)
    expect(row.name).toBe('Ahorro')
    expect(row.color).toBe('#10B981')
  })
})

describe('exclusión de los totales', () => {
  let udb
  beforeEach(() => {
    ;({ udb } = makeUserDb())
    udb.insert(gasto({ amount: 1000, category: 'Comida' }))
    udb.insert(gasto({ amount: 500, category: 'Movimientos internos', merchant: 'TRANSF A MI CUENTA' }))
    udb.insert(gasto({ amount: 50, category: 'Movimientos internos', currency: 'USD' }))
  })

  it('resumenMes no suma las excluidas (ARS ni USD) ni las lista en categoriasArs', () => {
    const r = udb.resumenMes('2026-07')
    expect(r.totalArs).toBe(1000)
    expect(r.totalUsd).toBe(0)
    expect(r.categoriasArs).toEqual({ Comida: 1000 })
  })

  it('compararMeses no suma las excluidas', () => {
    const r = udb.compararMeses('2026-07', '2026-06')
    expect(r['2026-07']).toEqual({ totalArs: 1000, totalUsd: 0 })
  })

  it('listarGastos sí muestra los movimientos excluidos (se ven, no suman)', () => {
    const r = udb.listarGastos({ month: '2026-07' })
    expect(r).toHaveLength(3)
  })

  it('togglear el flag cambia los totales retroactivamente', () => {
    const internos = udb.listCategories().find((c) => c.name === 'Movimientos internos')
    udb.updateCategoryDef(internos.id, { excluded: false })
    expect(udb.resumenMes('2026-07').totalArs).toBe(1500)
  })
})

describe('rutas HTTP', () => {
  it('GET /api/expenses: totals no incluye categorías excluidas', async () => {
    const { db, user, app } = makeAppWithUser()
    const udb = db.forUser(user.id)
    udb.insert(gasto({ amount: 1000, category: 'Comida' }))
    udb.insert(gasto({ amount: 500, category: 'Movimientos internos' }))
    const agent = await authedAgent(app)
    const res = await agent.get('/api/expenses?month=2026-07')
    expect(res.body.totals).toEqual({ Comida: 1000 })
    expect(res.body.expenses).toHaveLength(2) // se siguen viendo
  })

  it('GET /api/categories devuelve excluded y PATCH lo togglea', async () => {
    const { app } = makeAppWithUser()
    const agent = await authedAgent(app)
    const cats = (await agent.get('/api/categories')).body.categories
    const internos = cats.find((c) => c.name === 'Movimientos internos')
    expect(internos.excluded).toBe(1)

    const res = await agent.patch(`/api/categories/${internos.id}`).send({ excluded: false })
    expect(res.status).toBe(200)
    const after = (await agent.get('/api/categories')).body.categories
    expect(after.find((c) => c.name === 'Movimientos internos').excluded).toBe(0)
  })
})

describe('migración: DB multi-user previa sin la columna excluded', () => {
  let dbPath
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix
      if (existsSync(f)) unlinkSync(f)
    }
  }

  // Réplica del esquema multi-user ANTERIOR a este feature (categories sin excluded).
  function seedPreFeatureDb(path) {
    const sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.exec(`
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, gmail_message_id TEXT NOT NULL,
        amount REAL NOT NULL, merchant TEXT NOT NULL, category TEXT NOT NULL, card TEXT,
        occurred_at TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'ARS',
        source TEXT NOT NULL DEFAULT 'santander', needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE comercios_conocidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, match TEXT NOT NULL,
        category TEXT NOT NULL, alias TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX ux_expenses_user_msg ON expenses(user_id, gmail_message_id);
      CREATE UNIQUE INDEX ux_comercios_user_match ON comercios_conocidos(user_id, match);
      CREATE UNIQUE INDEX ux_categories_user_name ON categories(user_id, name);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, ingest_token TEXT NOT NULL UNIQUE,
        whatsapp_number TEXT UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    // Dos usuarios existentes con su seed viejo de 8 categorías.
    for (const [id, email] of [[1, 'gaston@test.com'], [2, 'novia@test.com']]) {
      sqlite.prepare('INSERT INTO users (id, email, password_hash, ingest_token) VALUES (?, ?, ?, ?)')
        .run(id, email, 'scrypt$x$y', `tok-${id}`)
      for (const [n, c] of [['Comida', '#FF6B35'], ['Otros', '#64748B'], ['Transferencias', '#F59E0B']]) {
        sqlite.prepare('INSERT INTO categories (user_id, name, color) VALUES (?, ?, ?)').run(id, n, c)
      }
    }
    sqlite.close()
  }

  beforeEach(() => {
    dbPath = join(tmpdir(), `gastaker-excluded-${process.pid}-${Date.now()}.db`)
    cleanup()
    seedPreFeatureDb(dbPath)
  })
  afterEach(cleanup)

  it('agrega la columna y seedea "Movimientos internos" a cada usuario existente', () => {
    const db = createDb(dbPath)
    for (const userId of [1, 2]) {
      const cats = db.forUser(userId).listCategories()
      const internos = cats.find((c) => c.name === 'Movimientos internos')
      expect(internos).toBeDefined()
      expect(internos.excluded).toBe(1)
      // Las viejas quedan con excluded=0.
      expect(cats.find((c) => c.name === 'Comida').excluded).toBe(0)
    }
  })

  it('es idempotente: correr createDb dos veces no duplica la categoría', () => {
    createDb(dbPath)._raw.close()
    const db = createDb(dbPath)
    const internos = db.forUser(1).listCategories().filter((c) => c.name === 'Movimientos internos')
    expect(internos).toHaveLength(1)
  })
})
