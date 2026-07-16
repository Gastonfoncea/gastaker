// test/routes/categories.test.js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import { createDb } from '../../src/db.js'
import { TEST_CONFIG, authedAgent } from '../helpers.js'

// makeApp devuelve { db, app } y udb scopeada; el user tiene email/password fijos.
function makeApp() {
  const db = createDb(':memory:')
  const user = db.createUser({ email: 'test@test.com', password: 'clave-test' })
  return { db, app: createApp({ db, config: TEST_CONFIG }), udb: db.forUser(user.id) }
}

describe('/api/categories', () => {
  it('sin cookie devuelve 401', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/categories')).status).toBe(401)
  })

  it('GET lista las categorías seed con count', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const res = await agent.get('/api/categories')
    expect(res.status).toBe(200)
    expect(res.body.categories).toHaveLength(10)
    expect(res.body.categories[0]).toMatchObject({ name: 'Comida', color: '#FF6B35', count: 0 })
  })

  it('POST crea una categoría', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const res = await agent.post('/api/categories').send({ name: 'Ropa', color: '#EF4444' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Ropa', color: '#EF4444' })
  })

  it('POST duplicado da 409, inválido da 400', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    expect((await agent.post('/api/categories').send({ name: 'comida', color: '#EF4444' })).status).toBe(409)
    expect((await agent.post('/api/categories').send({ name: '', color: '#EF4444' })).status).toBe(400)
    expect((await agent.post('/api/categories').send({ name: 'Ropa', color: 'rojo' })).status).toBe(400)
  })

  it('PATCH renombra (cascadea) y DELETE mueve a Otros', async () => {
    const { app, udb } = makeApp()
    udb.insert({ gmail_message_id: 'a', amount: 100, merchant: 'VERDULERIA KATIE', category: 'Comida', occurred_at: '2026-06-01T10:00:00' })
    const agent = await authedAgent(app)
    const comida = (await agent.get('/api/categories')).body.categories.find((c) => c.name === 'Comida')

    const ren = await agent.patch(`/api/categories/${comida.id}`).send({ name: 'Morfi' })
    expect(ren.status).toBe(200)
    expect(udb.list('2026-06')[0].category).toBe('Morfi')

    const del = await agent.delete(`/api/categories/${comida.id}`)
    expect(del.status).toBe(200)
    expect(del.body.movidos).toBe(1)
    expect(udb.list('2026-06')[0].category).toBe('Otros')
  })

  it('Otros está protegida: PATCH de nombre y DELETE dan 400', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    const otros = (await agent.get('/api/categories')).body.categories.find((c) => c.name === 'Otros')
    expect((await agent.patch(`/api/categories/${otros.id}`).send({ name: 'Misc' })).status).toBe(400)
    expect((await agent.delete(`/api/categories/${otros.id}`)).status).toBe(400)
  })

  it('id inexistente da 404', async () => {
    const { app } = makeApp()
    const agent = await authedAgent(app)
    expect((await agent.patch('/api/categories/9999').send({ name: 'X' })).status).toBe(404)
    expect((await agent.delete('/api/categories/9999')).status).toBe(404)
  })
})
