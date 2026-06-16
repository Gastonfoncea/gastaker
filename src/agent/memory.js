// src/agent/memory.js
// Historial de conversación por número de WhatsApp, en RAM.
// Se descarta tras `ttlMs` de inactividad (hilo nuevo). `now` es inyectable para tests.
export function createMemory({ ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
  const store = new Map() // number -> { messages, lastActiveAt }

  return {
    load(number) {
      const entry = store.get(number)
      if (!entry) return []
      if (now() - entry.lastActiveAt > ttlMs) {
        store.delete(number)
        return []
      }
      return entry.messages
    },
    save(number, messages) {
      store.set(number, { messages, lastActiveAt: now() })
    },
  }
}
