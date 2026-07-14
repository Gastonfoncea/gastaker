// test/isolation.test.js — el invariante crítico: los datos de un usuario NUNCA
// se cruzan con los de otro. Rutas HTTP + capa db.
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { TEST_CONFIG, authedAgent } from './helpers.js'

describe('aislamiento entre usuarios', () => {
  let db, app, A, B

  beforeEach(() => {
    db = createDb(':memory:')
    A = db.createUser({ email: 'a@test.com', password: 'clave-a' })
    B = db.createUser({ email: 'b@test.com', password: 'clave-b' })
    app = createApp({ db, config: TEST_CONFIG })
    // A tiene un gasto de Comida; B tiene un gasto de Transporte.
    db.forUser(A.id).insert({ gmail_message_id: 'a1', amount: 100, merchant: 'VERDU A', category: 'Comida', occurred_at: '2026-06-01T10:00:00' })
    db.forUser(B.id).insert({ gmail_message_id: 'b1', amount: 200, merchant: 'UBER B', category: 'Transporte', occurred_at: '2026-06-02T10:00:00' })
  })

  it('GET /api/expenses de A no incluye gastos de B', async () => {
    const agentA = await authedAgent(app, { email: 'a@test.com', password: 'clave-a' })
    const res = await agentA.get('/api/expenses?month=2026-06')
    expect(res.body.expenses).toHaveLength(1)
    expect(res.body.expenses[0].merchant).toBe('VERDU A')
  })

  it('PATCH /api/expenses/:id de A sobre un gasto de B da 404', async () => {
    const bExpenseId = db.forUser(B.id).list('2026-06')[0].id
    const agentA = await authedAgent(app, { email: 'a@test.com', password: 'clave-a' })
    const res = await agentA.patch(`/api/expenses/${bExpenseId}`).send({ category: 'Comida' })
    expect(res.status).toBe(404)
    // El gasto de B quedó intacto.
    expect(db.forUser(B.id).getExpense(bExpenseId).category).toBe('Transporte')
  })

  it('cada usuario tiene sus propias 9 categorías seed, independientes', async () => {
    db.forUser(A.id).createCategory({ name: 'Hobbies', color: '#123456' })
    expect(db.forUser(A.id).listCategories().some((c) => c.name === 'Hobbies')).toBe(true)
    expect(db.forUser(B.id).listCategories().some((c) => c.name === 'Hobbies')).toBe(false)
    expect(db.forUser(B.id).listCategories()).toHaveLength(9)
  })

  it('rename de "Comida" en A no toca categorías ni gastos de B', () => {
    const comidaA = db.forUser(A.id).listCategories().find((c) => c.name === 'Comida')
    db.forUser(A.id).updateCategoryDef(comidaA.id, { name: 'Morfi' })
    // A cambió; B sigue con "Comida" y su gasto en Transporte intacto.
    expect(db.forUser(A.id).list('2026-06')[0].category).toBe('Morfi')
    expect(db.forUser(B.id).listCategories().some((c) => c.name === 'Comida')).toBe(true)
    expect(db.forUser(B.id).listCategories().some((c) => c.name === 'Morfi')).toBe(false)
    expect(db.forUser(B.id).list('2026-06')[0].category).toBe('Transporte')
  })

  it('delete de una categoría en A no afecta las reglas/comercios de B', () => {
    // Ambos registran un comercio con el mismo match, en distinta categoría.
    db.forUser(A.id).registrarComercio({ match: 'SHARED', categoria: 'Comida' })
    db.forUser(B.id).registrarComercio({ match: 'SHARED', categoria: 'Transporte' })
    const comidaA = db.forUser(A.id).listCategories().find((c) => c.name === 'Comida')
    db.forUser(A.id).deleteCategory(comidaA.id)
    // A perdió su regla; B la conserva.
    expect(db.forUser(A.id).findLearned('COMPRA SHARED')).toBeNull()
    expect(db.forUser(B.id).findLearned('COMPRA SHARED')).toBe('Transporte')
  })

  it('"Otros" es por-usuario: cada uno tiene la suya protegida', () => {
    const otrosA = db.forUser(A.id).listCategories().find((c) => c.name === 'Otros')
    const otrosB = db.forUser(B.id).listCategories().find((c) => c.name === 'Otros')
    expect(otrosA.id).not.toBe(otrosB.id)
  })

  it('el mismo gmail_message_id puede existir en dos usuarios (índice compuesto)', () => {
    // A ya tiene 'a1'; B inserta 'a1' también -> coexisten, uno por usuario.
    const r = db.forUser(B.id).insert({ gmail_message_id: 'a1', amount: 55, merchant: 'X', category: 'Otros', occurred_at: '2026-06-03T10:00:00' })
    expect(r.inserted).toBe(true)
    expect(db.forUser(A.id).list('2026-06').find((e) => e.gmail_message_id === 'a1').amount).toBe(100)
    expect(db.forUser(B.id).list('2026-06').find((e) => e.gmail_message_id === 'a1').amount).toBe(55)
  })

  it('getUserByIngestToken resuelve al dueño correcto', () => {
    expect(db.getUserByIngestToken(A.ingest_token).id).toBe(A.id)
    expect(db.getUserByIngestToken(B.ingest_token).id).toBe(B.id)
  })
})
