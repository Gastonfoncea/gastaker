// test/payment-method.test.js — medio de pago (Crédito/Débito) en expenses.
// Los consumos con crédito no suman al total del mes: se debitan el mes siguiente.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import request from 'supertest'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { makeUserDb, TEST_CONFIG } from './helpers.js'

const MAIL_CREDITO = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Crédito terminada en 2044.

Monto
$50.000,00

Comercio
COTO SUC 99

Fecha
10/07/2026

Hora
12:00`

const MAIL_DEBITO = `Te acercamos el detalle de tu consumo con la Tarjeta Santander Visa Débito terminada en 1458.

Monto
$12.946,00

Comercio
VERDULERIA KATIE

Fecha
08/07/2026

Hora
19:12`

const gasto = (over = {}) => ({
  gmail_message_id: `m-${Math.random()}`,
  amount: 100,
  merchant: 'X',
  category: 'Comida',
  occurred_at: '2026-07-01T10:00:00',
  ...over,
})

describe('columna payment_method', () => {
  it('insert() persiste payment_method y defaultea a null', () => {
    const { udb } = makeUserDb()
    udb.insert(gasto({ gmail_message_id: 'm-cred', payment_method: 'Crédito' }))
    udb.insert(gasto({ gmail_message_id: 'm-deb', payment_method: 'Débito' }))
    udb.insert(gasto({ gmail_message_id: 'm-sin' }))
    const rows = udb.list('2026-07')
    expect(rows.find((r) => r.gmail_message_id === 'm-cred').payment_method).toBe('Crédito')
    expect(rows.find((r) => r.gmail_message_id === 'm-deb').payment_method).toBe('Débito')
    expect(rows.find((r) => r.gmail_message_id === 'm-sin').payment_method).toBeNull()
  })

  it('el seed de un usuario nuevo incluye la categoría "Tarjeta" (excluded=0)', () => {
    const { udb } = makeUserDb()
    const tarjeta = udb.listCategories().find((c) => c.name === 'Tarjeta')
    expect(tarjeta).toBeDefined()
    expect(tarjeta.excluded).toBe(0)
    expect(tarjeta.color).toBe('#DC2626')
  })
})

describe('migración: DB multi-user previa sin payment_method', () => {
  let dbPath
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix
      if (existsSync(f)) unlinkSync(f)
    }
  }

  // Réplica del esquema ANTERIOR a este feature (expenses sin payment_method).
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
        color TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    sqlite.prepare('INSERT INTO users (id, email, password_hash, ingest_token) VALUES (1, ?, ?, ?)')
      .run('gaston@test.com', 'scrypt$x$y', 'tok-1')
    sqlite.prepare(`
      INSERT INTO expenses (user_id, gmail_message_id, amount, merchant, category, occurred_at)
      VALUES (1, 'm-viejo', 1000, 'VERDULERIA', 'Comida', '2026-07-01T10:00:00')
    `).run()
    sqlite.close()
  }

  beforeEach(() => {
    dbPath = join(tmpdir(), `gastaker-paymethod-${process.pid}-${Date.now()}.db`)
    cleanup()
    seedPreFeatureDb(dbPath)
  })
  afterEach(cleanup)

  it('agrega la columna; las filas viejas quedan en NULL', () => {
    const db = createDb(dbPath)
    const cols = db._raw.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name)
    expect(cols).toContain('payment_method')
    const viejo = db.forUser(1).list('2026-07').find((r) => r.gmail_message_id === 'm-viejo')
    expect(viejo.payment_method).toBeNull()
  })

  it('backfillea la categoría "Tarjeta" a los usuarios existentes', () => {
    const db = createDb(dbPath)
    const tarjeta = db.forUser(1).listCategories().find((c) => c.name === 'Tarjeta')
    expect(tarjeta).toBeDefined()
    expect(tarjeta.excluded).toBe(0)
  })

  it('es idempotente: correr createDb dos veces no rompe ni duplica "Tarjeta"', () => {
    createDb(dbPath)._raw.close()
    const db = createDb(dbPath)
    expect(db.forUser(1).list('2026-07')).toHaveLength(1)
    expect(db.forUser(1).listCategories().filter((c) => c.name === 'Tarjeta')).toHaveLength(1)
  })
})

describe('ingesta: persiste el medio de pago', () => {
  let db, app, token, udb
  beforeEach(() => {
    db = createDb(':memory:')
    const user = db.createUser({ email: 'u@test.com', password: 'x' })
    app = createApp({ db, config: TEST_CONFIG })
    token = user.ingest_token
    udb = db.forUser(user.id)
  })

  const ingest = (messageId, body) =>
    request(app).post('/api/ingest').set('X-Webhook-Secret', token).send({ messageId, body })

  it('un consumo con crédito guarda payment_method = Crédito', async () => {
    const res = await ingest('m-cred', MAIL_CREDITO)
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(true)
    expect(udb.list('2026-07').find((r) => r.gmail_message_id === 'm-cred').payment_method).toBe('Crédito')
  })

  it('un consumo con débito guarda payment_method = Débito', async () => {
    await ingest('m-deb', MAIL_DEBITO)
    expect(udb.list('2026-07').find((r) => r.gmail_message_id === 'm-deb').payment_method).toBe('Débito')
  })
})
