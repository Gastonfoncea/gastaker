// test/agent/agent.test.js
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../../src/agent/agent.js'

// Cliente de Claude falso: primero pide una tool, después responde texto.
function fakeClient(steps) {
  let i = 0
  return { messages: { create: vi.fn(async () => steps[i++]) } }
}

const tools = [{ name: 'resumen_mes', description: '', input_schema: { type: 'object', properties: {} } }]

describe('runAgent', () => {
  it('ejecuta la tool pedida y devuelve la respuesta final', async () => {
    const client = fakeClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'resumen_mes', input: { mes: '2026-06' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Gastaste $1500.' }] },
    ])
    const executeTool = vi.fn(async () => ({ totalArs: 1500 }))
    const text = await runAgent({
      client, model: 'claude-haiku-4-5', system: 'sos gastaker',
      tools, executeTool, messages: [{ role: 'user', content: '¿cuánto gasté?' }],
    })
    expect(text).toBe('Gastaste $1500.')
    expect(executeTool).toHaveBeenCalledWith('resumen_mes', { mes: '2026-06' })
  })

  it('responde directo si no usa herramientas', async () => {
    const client = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hola!' }] }])
    const text = await runAgent({ client, model: 'm', system: 's', tools, executeTool: vi.fn(), messages: [{ role: 'user', content: 'hola' }] })
    expect(text).toBe('Hola!')
  })
})
