// test/agent/memory.test.js
import { describe, it, expect } from 'vitest'
import { createMemory } from '../../src/agent/memory.js'

describe('memory', () => {
  it('guarda y devuelve el historial de un número', () => {
    const mem = createMemory({ now: () => 1000 })
    mem.save('549', [{ role: 'user', content: 'hola' }])
    expect(mem.load('549')).toEqual([{ role: 'user', content: 'hola' }])
  })

  it('aísla por número', () => {
    const mem = createMemory({ now: () => 1000 })
    mem.save('549', [{ role: 'user', content: 'a' }])
    expect(mem.load('111')).toEqual([])
  })

  it('descarta el historial tras la inactividad (TTL)', () => {
    let t = 1000
    const mem = createMemory({ ttlMs: 100, now: () => t })
    mem.save('549', [{ role: 'user', content: 'a' }])
    t = 1050
    expect(mem.load('549')).toHaveLength(1) // dentro del TTL
    t = 2000
    expect(mem.load('549')).toEqual([]) // pasó el TTL -> hilo nuevo
  })
})
