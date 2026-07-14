// test/agent/tools.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTools } from '../../src/agent/tools.js'
import { createDb } from '../../src/db.js'

function seed(db) {
  db.insert({ gmail_message_id: 'a', amount: 1500, merchant: 'VERDU', category: 'Comida', occurred_at: '2026-06-01T10:00:00', currency: 'ARS' })
}

describe('buildTools (read)', () => {
  let db, tools
  beforeEach(() => {
    db = createDb(':memory:')
    seed(db)
    tools = buildTools(db)
  })

  it('expone las herramientas de consulta', () => {
    const names = tools.definitions.map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining(['resumen_mes', 'listar_gastos', 'comparar_meses', 'pendientes']))
  })

  it('execute(resumen_mes) consulta la base', async () => {
    const r = await tools.execute('resumen_mes', { mes: '2026-06' })
    expect(r.totalArs).toBe(1500)
  })

  it('execute con tool desconocida devuelve error', async () => {
    const r = await tools.execute('no_existe', {})
    expect(r.error).toBeTruthy()
  })

  it('execute(registrar_comercio) guarda la regla y devuelve actualizados', async () => {
    const r = await tools.execute('registrar_comercio', { match: 'NETFLIX', categoria: 'Suscripciones' })
    expect(r.inserted).toBe(true)
  })
})
