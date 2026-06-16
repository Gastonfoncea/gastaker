# Agente de gastos por WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el eco de `/api/whatsapp` por un agente (Claude Haiku + herramientas) que responde preguntas sobre los gastos consultando SQLite, y que aprende a clasificar comercios/CUITs recurrentes. Incluye un notifier proactivo construido pero inactivo.

**Architecture:** Loop manual de tool-use con el SDK de Anthropic, en el mismo backend Express. El agente solo lee/escribe vía funciones de `db.js` (nunca SQL libre del LLM). Memoria de conversación en RAM por número (reset a 30 min). Solo el número autorizado interactúa.

**Tech Stack:** Node.js (ESM), `@anthropic-ai/sdk`, Express, better-sqlite3. Tests con Vitest + Supertest. Modelo `claude-haiku-4-5`.

**Spec:** `docs/superpowers/specs/2026-06-16-whatsapp-agent-design.md`

**Datos fijos:** modelo por defecto `claude-haiku-4-5` (env `ANTHROPIC_MODEL`). Haiku 4.5 **no** soporta `effort` ni `thinking` adaptativo → no se pasan esos parámetros (darían 400). El número autorizado es `NOTIFY_WHATSAPP`.

---

## File Structure

```
src/agent/
├── memory.js     # historial en RAM por número, expira a 30 min (factory inyectable)
├── tools.js      # buildTools(db) -> { definitions, execute(name, input) }
├── agent.js      # runAgent(...) loop manual de tool-use (cliente inyectable)
└── notifier.js   # avisarSinClasificar(expense) — feature-flag, inactivo por defecto
src/db.js         # + needs_review, comercios_conocidos, consultas, clasificación, findLearned
src/routes/whatsapp.js  # reemplaza el eco por el agente (solo número autorizado)
src/routes/ingest.js    # usa findLearned, setea needs_review, dispara notifier
src/app.js / server.js  # pasar config nueva (allowedNumber, anthropicModel)
test/agent/*, test/db.test.js, test/routes/whatsapp.test.js
```

**Shapes (consistentes en todo el plan):**
- Tool definition: `{ name, description, input_schema }` (JSON Schema).
- `buildTools(db)` → `{ definitions: ToolDef[], execute(name, input): Promise<any> }`.
- `runAgent({ client, model, system, tools, executeTool, messages, maxSteps })` → `Promise<string>` (texto final).
- memory: `createMemory({ ttlMs, now })` → `{ load(number): Msg[], save(number, msgs) }`.

---

# FASE 1 — Agente de consulta (read-only)

## Task 1: Instalar el SDK de Anthropic

**Files:** Modify `package.json`

- [ ] **Step 1: Instalar**

Run: `npm install @anthropic-ai/sdk`
Expected: agrega `@anthropic-ai/sdk` a `dependencies` sin errores.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: agregar @anthropic-ai/sdk para el agente"
```

---

## Task 2: Memoria de conversación en RAM

**Files:** Create `src/agent/memory.js`, Test `test/agent/memory.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
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
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- agent/memory`
Expected: FAIL — no encuentra `createMemory`.

- [ ] **Step 3: Implementar `src/agent/memory.js`**

```javascript
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
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- agent/memory`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory.js test/agent/memory.test.js
git commit -m "feat: memoria de conversación en RAM con TTL (agente WhatsApp)"
```

---

## Task 3: Consultas de lectura en db.js

**Files:** Modify `src/db.js`, Test `test/db.test.js`

- [ ] **Step 1: Escribir el test que falla (agregar a `test/db.test.js`)**

```javascript
  it('resumenMes devuelve totales por moneda y por categoría (solo neto > 0)', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', amount: 1000, category: 'Comida', occurred_at: '2026-06-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', amount: 500, category: 'Comida', occurred_at: '2026-06-02T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'c', amount: 6.33, currency: 'USD', category: 'Suscripciones', occurred_at: '2026-06-03T10:00:00' }))
    const r = db.resumenMes('2026-06')
    expect(r.totalArs).toBe(1500)
    expect(r.totalUsd).toBe(6.33)
    expect(r.categoriasArs).toEqual({ Comida: 1500 })
  })

  it('listarGastos filtra por categoría y comercio', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', merchant: 'UBER', category: 'Transporte' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', merchant: 'VERDU', category: 'Comida' }))
    expect(db.listarGastos({ month: '2026-06', categoria: 'Transporte' })).toHaveLength(1)
    expect(db.listarGastos({ month: '2026-06', comercio: 'VERD' })).toHaveLength(1)
    expect(db.listarGastos({ month: '2026-06' })).toHaveLength(2)
  })

  it('compararMeses devuelve totales de cada mes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'a', amount: 100, occurred_at: '2026-05-01T10:00:00' }))
    db.insert(sampleRecord({ gmail_message_id: 'b', amount: 200, occurred_at: '2026-06-01T10:00:00' }))
    const r = db.compararMeses('2026-05', '2026-06')
    expect(r['2026-05'].totalArs).toBe(100)
    expect(r['2026-06'].totalArs).toBe(200)
  })
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- db`
Expected: FAIL — `db.resumenMes is not a function`.

- [ ] **Step 3: Implementar en `src/db.js`** (agregar dentro del objeto que devuelve `createDb`, junto a `list`/`insert`)

```javascript
    // Resumen del mes: total ARS, total USD, y desglose ARS por categoría (neto > 0).
    resumenMes(month) {
      const rows = listStmt.all({ prefix: `${month}%` })
      let totalArs = 0
      let totalUsd = 0
      const cat = {}
      for (const r of rows) {
        if (r.currency === 'USD') totalUsd += r.amount
        else {
          totalArs += r.amount
          cat[r.category] = (cat[r.category] || 0) + r.amount
        }
      }
      const categoriasArs = {}
      for (const [k, v] of Object.entries(cat)) if (v > 0) categoriasArs[k] = v
      return { month, totalArs, totalUsd, categoriasArs }
    },

    // Lista de movimientos del mes, opcionalmente filtrada (máx 50).
    listarGastos({ month, categoria, comercio }) {
      return listStmt
        .all({ prefix: `${month}%` })
        .filter((r) => (categoria ? r.category === categoria : true))
        .filter((r) => (comercio ? r.merchant.toUpperCase().includes(comercio.toUpperCase()) : true))
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          fecha: r.occurred_at,
          comercio: r.merchant,
          categoria: r.category,
          monto: r.amount,
          moneda: r.currency,
        }))
    },

    compararMeses(mesA, mesB) {
      const tot = (m) => {
        const rows = listStmt.all({ prefix: `${m}%` })
        return {
          totalArs: rows.filter((r) => r.currency !== 'USD').reduce((s, r) => s + r.amount, 0),
          totalUsd: rows.filter((r) => r.currency === 'USD').reduce((s, r) => s + r.amount, 0),
        }
      }
      return { [mesA]: tot(mesA), [mesB]: tot(mesB) }
    },
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: consultas de lectura para el agente (resumenMes, listarGastos, compararMeses)"
```

---

## Task 4: Herramientas del agente (read-only)

**Files:** Create `src/agent/tools.js`, Test `test/agent/tools.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
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
})
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- agent/tools`
Expected: FAIL — no encuentra `buildTools`.

- [ ] **Step 3: Implementar `src/agent/tools.js`**

```javascript
// src/agent/tools.js
// Define las herramientas del agente y las ejecuta contra db.js.
// El LLM elige la herramienta + parámetros; el SQL real vive en db.js.
export function buildTools(db) {
  const definitions = [
    {
      name: 'resumen_mes',
      description: 'Total gastado en un mes (pesos y dólares por separado) y desglose por categoría. Usar para "¿cuánto gasté?", "¿en qué se me va la plata?".',
      input_schema: {
        type: 'object',
        properties: { mes: { type: 'string', description: 'Mes en formato YYYY-MM, ej. 2026-06' } },
        required: ['mes'],
      },
    },
    {
      name: 'listar_gastos',
      description: 'Lista los movimientos de un mes, opcionalmente filtrados por categoría o por comercio (substring). Usar para "mostrame los de comida", "¿qué pagué en Uber?".',
      input_schema: {
        type: 'object',
        properties: {
          mes: { type: 'string', description: 'YYYY-MM' },
          categoria: { type: 'string', description: 'Categoría exacta, opcional' },
          comercio: { type: 'string', description: 'Parte del nombre del comercio, opcional' },
        },
        required: ['mes'],
      },
    },
    {
      name: 'comparar_meses',
      description: 'Compara los totales de dos meses. Usar para "mayo vs junio".',
      input_schema: {
        type: 'object',
        properties: { mes_a: { type: 'string' }, mes_b: { type: 'string' } },
        required: ['mes_a', 'mes_b'],
      },
    },
    {
      name: 'pendientes',
      description: 'Lista los gastos que quedaron sin clasificar (desconocidos). Usar para "¿qué quedó sin clasificar?".',
      input_schema: { type: 'object', properties: {} },
    },
  ]

  async function execute(name, input) {
    try {
      switch (name) {
        case 'resumen_mes':
          return db.resumenMes(input.mes)
        case 'listar_gastos':
          return db.listarGastos({ month: input.mes, categoria: input.categoria, comercio: input.comercio })
        case 'comparar_meses':
          return db.compararMeses(input.mes_a, input.mes_b)
        case 'pendientes':
          return db.pendientes()
        default:
          return { error: `herramienta desconocida: ${name}` }
      }
    } catch (e) {
      return { error: e.message }
    }
  }

  return { definitions, execute }
}
```

> Nota: `db.pendientes()` se implementa en la Fase 2 (Task 7). Hasta entonces este test no llama a `pendientes`; el resto de las herramientas funciona. Si ejecutás Fase 1 sola, agregá un stub `pendientes() { return [] }` en db.js y reemplazalo en Task 7.

- [ ] **Step 4: Agregar el stub de `pendientes` en `src/db.js`** (para que Fase 1 corra aislada; Task 7 lo reemplaza por la versión real)

```javascript
    pendientes() {
      return [] // reemplazado en Task 7 (Fase 2)
    },
```

- [ ] **Step 5: Correr el test (pasa)**

Run: `npm test -- agent/tools`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.js src/db.js test/agent/tools.test.js
git commit -m "feat: herramientas de consulta del agente (read-only)"
```

---

## Task 5: El loop del agente (tool-use manual)

**Files:** Create `src/agent/agent.js`, Test `test/agent/agent.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
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
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- agent/agent`
Expected: FAIL — no encuentra `runAgent`.

- [ ] **Step 3: Implementar `src/agent/agent.js`**

```javascript
// src/agent/agent.js
import Anthropic from '@anthropic-ai/sdk'

// Cliente real por defecto (lee ANTHROPIC_API_KEY del entorno). Inyectable en tests.
const defaultClient = new Anthropic()

// Loop manual de tool-use. Devuelve el texto final de Claude.
// `messages` son turnos {role, content} (texto). Las idas y vueltas de tools
// se manejan en una copia local y NO se devuelven (la memoria guarda solo texto).
export async function runAgent({
  client = defaultClient,
  model,
  system,
  tools,
  executeTool,
  messages,
  maxSteps = 6,
}) {
  const msgs = [...messages]

  for (let step = 0; step < maxSteps; step++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools,
      messages: msgs,
    })

    if (resp.stop_reason !== 'tool_use') {
      return resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    }

    msgs.push({ role: 'assistant', content: resp.content })
    const results = []
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue
      const result = await executeTool(block.name, block.input)
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: Boolean(result && result.error),
      })
    }
    msgs.push({ role: 'user', content: results })
  }

  return 'No pude completar la consulta, probá de nuevo más simple.'
}

// System prompt del agente. `today` = 'YYYY-MM-DD' (para resolver "este mes").
export function systemPrompt(today) {
  const mes = today.slice(0, 7)
  return [
    'Sos gastaker, un asistente de gastos personales por WhatsApp. Hablás en español, breve y claro.',
    `Hoy es ${today} (mes actual ${mes}). Si el usuario dice "este mes" usá ${mes}.`,
    'Respondés preguntas sobre los gastos usando las herramientas (no inventes números: siempre consultá).',
    'Los montos en pesos (ARS) y en dólares (USD) son distintos: nunca los sumes entre sí.',
    'Para clasificar: si un gasto es de un comercio/CUIT recurrente usá registrar_comercio (aprende para el futuro);',
    'si es algo puntual que no se repite usá clasificar_gasto. Ante la duda, preguntá.',
    'IMPORTANTE: el "match" de registrar_comercio debe ser un identificador específico (el CUIT de la transferencia,',
    'o una parte distintiva del comercio), NUNCA una palabra genérica como "Transferencia".',
  ].join(' ')
}
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- agent/agent`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.js test/agent/agent.test.js
git commit -m "feat: loop de tool-use del agente (cliente inyectable) + system prompt"
```

---

## Task 6: Conectar el agente a /api/whatsapp

**Files:** Modify `src/routes/whatsapp.js`, `src/app.js`, `src/server.js`, `.env.example`, Test `test/routes/whatsapp.test.js`

- [ ] **Step 1: Escribir el test que falla (reescribe el comportamiento del webhook)**

Agregar a `test/routes/whatsapp.test.js`:

```javascript
import { createMemory } from '../../src/agent/memory.js'

function payloadFrom(from, text) {
  return { message: { from, type: 'text', text: { body: text } } }
}

describe('agente en /api/whatsapp', () => {
  it('ignora (200, sin responder) si el número no está autorizado', async () => {
    const send = vi.fn()
    const runAgent = vi.fn(async () => 'no debería')
    const app = makeAppAgent({ send, runAgent, allowedNumber: '549111' })
    const p = payloadFrom('549999', 'hola')
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    expect(res.status).toBe(200)
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('del número autorizado: corre el agente y responde por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    const runAgent = vi.fn(async () => 'Gastaste $1500 en junio.')
    const app = makeAppAgent({ send, runAgent, allowedNumber: '549111' })
    const p = payloadFrom('549111', '¿cuánto gasté?')
    const res = await request(app).post('/api/whatsapp').set('X-Webhook-Signature', sign(p)).send(p)
    expect(res.status).toBe(200)
    expect(runAgent).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('549111', 'Gastaste $1500 en junio.')
  })
})

function makeAppAgent({ send, runAgent, allowedNumber }) {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/whatsapp',
    whatsappRouter({
      config: { kapsoWebhookSecret: SECRET, allowedNumber, anthropicModel: 'claude-haiku-4-5' },
      send,
      runAgent,
      memory: createMemory(),
      db: { /* no usado en estos tests */ },
    })
  )
  return app
}
```

(Reusa `SECRET`, `sign`, los imports de `express`, `request`, `whatsappRouter` que ya están en el archivo.)

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- routes/whatsapp`
Expected: FAIL — `whatsappRouter` aún no acepta `runAgent`/`memory`/`db` ni filtra por número.

- [ ] **Step 3: Reescribir `src/routes/whatsapp.js`**

```javascript
// src/routes/whatsapp.js
import express from 'express'
import { verifyKapsoSignature, sendWhatsApp } from '../whatsapp.js'
import { runAgent as realRunAgent, systemPrompt } from '../agent/agent.js'
import { buildTools } from '../agent/tools.js'

// Router del webhook entrante. Dependencias inyectables para testear sin red.
export function whatsappRouter({ config, send = sendWhatsApp, runAgent = realRunAgent, memory, db }) {
  const router = express.Router()

  router.post('/', async (req, res) => {
    const signature = req.get('X-Webhook-Signature')
    if (!verifyKapsoSignature(req.body, signature, config.kapsoWebhookSecret)) {
      return res.status(401).json({ error: 'firma inválida' })
    }
    // Responder rápido siempre (Kapso exige < 10s); el trabajo va después.
    res.json({ ok: true })

    const msg = req.body?.message
    const from = msg?.from
    const text = msg?.text?.body
    if (!from || !text) return
    // Solo el número autorizado (son finanzas personales).
    if (from !== config.allowedNumber) return

    try {
      const history = memory.load(from)
      const messages = [...history, { role: 'user', content: text }]
      const tools = buildTools(db)
      const today = new Date().toISOString().slice(0, 10)
      const reply = await runAgent({
        model: config.anthropicModel,
        system: systemPrompt(today),
        tools: tools.definitions,
        executeTool: tools.execute,
        messages,
      })
      memory.save(from, [...messages, { role: 'assistant', content: reply }])
      await send(from, reply)
    } catch (e) {
      console.error('agente falló:', e.message)
      try {
        await send(from, 'Ups, no pude procesar eso ahora, probá de nuevo.')
      } catch {}
    }
  })

  return router
}
```

- [ ] **Step 4: Cablear en `src/app.js`** — la app crea memoria una vez y pasa db + config

Reemplazar el montaje actual de `/api/whatsapp` por:

```javascript
import { createMemory } from './agent/memory.js'
// ... dentro de createApp, antes de montar las rutas:
  const memory = createMemory()
// ... y el montaje:
  app.use('/api/whatsapp', whatsappRouter({ config, db, memory }))
```

- [ ] **Step 5: Config en `src/server.js`**

En el objeto `config` agregar:

```javascript
  allowedNumber: requireEnv('NOTIFY_WHATSAPP'),
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
```

- [ ] **Step 6: `.env.example`**

```
# Modelo de Claude para el agente (Haiku por defecto)
ANTHROPIC_MODEL=claude-haiku-4-5
# La API key de Anthropic la lee el SDK de la env ANTHROPIC_API_KEY (sacala de console.anthropic.com)
ANTHROPIC_API_KEY=tu-api-key-de-anthropic
```

> `ANTHROPIC_API_KEY` la lee el SDK solo; no se referencia en el código (no va en `config`).

- [ ] **Step 7: Correr toda la suite**

Run: `npm test`
Expected: PASS — incluidos los nuevos tests del agente y los viejos del webhook.

- [ ] **Step 8: Commit**

```bash
git add src/routes/whatsapp.js src/app.js src/server.js .env.example test/routes/whatsapp.test.js
git commit -m "feat: agente conectado a /api/whatsapp (solo número autorizado, con memoria)"
```

---

# FASE 2 — Aprendizaje y clasificación

## Task 7: needs_review + tabla comercios_conocidos + findLearned + pendientes

**Files:** Modify `src/db.js`, Test `test/db.test.js`

- [ ] **Step 1: Escribir el test que falla (agregar a `test/db.test.js`)**

```javascript
  it('marca needs_review y lo lista en pendientes', () => {
    db.insert(sampleRecord({ gmail_message_id: 'p', category: 'Otros', needs_review: 1 }))
    const pend = db.pendientes()
    expect(pend).toHaveLength(1)
    expect(pend[0].comercio).toBe('VERDULERIA KATIE')
  })

  it('findLearned matchea por substring del comercio', () => {
    db.registrarComercio({ match: '20520522523', categoria: 'Vivienda', alias: 'Alquiler' })
    expect(db.findLearned('Transferencia · 20520522523')).toBe('Vivienda')
    expect(db.findLearned('OTRO COMERCIO')).toBeNull()
  })
```

- [ ] **Step 2: Correr (falla)**

Run: `npm test -- db`
Expected: FAIL — `needs_review` no existe / `db.findLearned is not a function`.

- [ ] **Step 3: Implementar en `src/db.js`**

a) En el `CREATE TABLE expenses`, agregar la columna:

```javascript
      needs_review      INTEGER NOT NULL DEFAULT 0,
```

b) Migración + tabla nueva (junto a las otras migraciones, después del CREATE):

```javascript
  if (!cols.includes('needs_review')) {
    sqlite.exec('ALTER TABLE expenses ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0')
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS comercios_conocidos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match       TEXT NOT NULL UNIQUE,
      category    TEXT NOT NULL,
      alias       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
```

c) Incluir `needs_review` en el INSERT: agregá `needs_review` a las columnas y `@needs_review` a los valores del `insertStmt`, y el default en `insert()`:

```javascript
    insert(record) {
      const info = insertStmt.run({ card: null, currency: 'ARS', source: 'santander', needs_review: 0, ...record })
      return { inserted: info.changes > 0 }
    },
```

d) Reemplazar el stub `pendientes()` (de Task 4) por la versión real, y agregar `findLearned`, `clasificarGasto`, `registrarComercio`:

```javascript
    pendientes() {
      return sqlite
        .prepare('SELECT * FROM expenses WHERE needs_review = 1 ORDER BY occurred_at DESC LIMIT 50')
        .all()
        .map((r) => ({ id: r.id, fecha: r.occurred_at, comercio: r.merchant, monto: r.amount, moneda: r.currency }))
    },

    // Busca una regla aprendida cuyo `match` esté contenido en el comercio. Devuelve la categoría o null.
    findLearned(merchant) {
      if (!merchant) return null
      const up = merchant.toUpperCase()
      for (const row of sqlite.prepare('SELECT match, category FROM comercios_conocidos').all()) {
        if (up.includes(row.match.toUpperCase())) return row.category
      }
      return null
    },
```

- [ ] **Step 4: Correr (pasa una vez exista `registrarComercio` — se implementa en Task 9). Por ahora, correr solo el test de `pendientes`/`needs_review`:**

Run: `npm test -- db`
Expected: el test de needs_review/pendientes PASA. El de `findLearned` queda rojo hasta Task 9 — implementá Task 9 a continuación (mismo commit lógico) y volvé a correr.

- [ ] **Step 5: Commit (tras Task 9)** — ver Task 9.

---

## Task 8: Integrar el aprendizaje en el ingest

**Files:** Modify `src/routes/ingest.js`, Test `test/ingest.test.js`

- [ ] **Step 1: Escribir el test que falla (agregar a `test/ingest.test.js`)**

```javascript
  it('un comercio desconocido entra con needs_review; tras registrarlo, el siguiente no', async () => {
    const db = createDb(':memory:')
    const app = createApp({ db, config: CONFIG })
    const body = `Aviso de consumo TD
Tarjeta Santander Visa Débito terminada en *1458*.
Monto
*$5.000,00*
Comercio
*KIOSCO RARO*
Fecha
*08/06/2026*
Hora
*10:00*`
    await request(app).post('/api/ingest').set('X-Webhook-Secret', 'secreto-test').send({ messageId: 'k1', body })
    expect(db.pendientes()).toHaveLength(1) // cayó en Otros -> pendiente

    db.registrarComercio({ match: 'KIOSCO RARO', categoria: 'Comida' })
    await request(app).post('/api/ingest').set('X-Webhook-Secret', 'secreto-test').send({ messageId: 'k2', body: body.replace('10:00', '11:00') })
    // el segundo NO queda pendiente (lo agarró findLearned)
    const last = db.list('2026-06').find((e) => e.gmail_message_id === 'k2')
    expect(last.category).toBe('Comida')
    expect(last.needs_review).toBe(0)
  })
```

(Asegurate de importar `createDb` y `createApp` arriba del archivo si no están.)

- [ ] **Step 2: Correr (falla)**

Run: `npm test -- ingest`
Expected: FAIL — el ingest todavía no usa `findLearned` ni setea `needs_review`.

- [ ] **Step 3: Modificar `src/routes/ingest.js`** — reemplazar el cálculo de categoría:

```javascript
    // Categoría: transferencia fija; si no, regla estática -> comercio aprendido -> default.
    let category
    let needsReview = 0
    if (parsed.kind === 'transferencia') {
      const learned = db.findLearned(parsed.merchant)
      category = learned || 'Transferencias'
      needsReview = learned ? 0 : 1
    } else {
      const byRule = categorize(parsed.merchant) // 'Otros' si no matchea
      if (byRule !== 'Otros') {
        category = byRule
      } else {
        const learned = db.findLearned(parsed.merchant)
        category = learned || 'Otros'
        needsReview = learned ? 0 : 1
      }
    }
```

Y agregar `needs_review: needsReview` al objeto que pasás a `db.insert({...})`.

- [ ] **Step 4: Correr (pasa)**

Run: `npm test -- ingest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/ingest.js test/ingest.test.js
git commit -m "feat: ingest usa comercios aprendidos y marca needs_review en los desconocidos"
```

---

## Task 9: clasificar_gasto y registrar_comercio (db + tools)

**Files:** Modify `src/db.js`, `src/agent/tools.js`, Test `test/db.test.js`, `test/agent/tools.test.js`

- [ ] **Step 1: Escribir el test que falla (agregar a `test/db.test.js`)**

```javascript
  it('clasificarGasto setea la categoría de un gasto y limpia needs_review', () => {
    db.insert(sampleRecord({ gmail_message_id: 'g', category: 'Otros', needs_review: 1 }))
    const id = db.list('2026-06')[0].id
    expect(db.clasificarGasto(id, 'Salud')).toBe(true)
    const row = db.list('2026-06')[0]
    expect(row.category).toBe('Salud')
    expect(row.needs_review).toBe(0)
  })

  it('registrarComercio guarda la regla y clasifica los pendientes que matchean', () => {
    db.insert(sampleRecord({ gmail_message_id: 't', merchant: 'Transferencia · 999', category: 'Transferencias', needs_review: 1 }))
    const r = db.registrarComercio({ match: '999', categoria: 'Vivienda', alias: 'Alquiler' })
    expect(r.inserted).toBe(true)
    expect(r.pendientesActualizados).toBe(1)
    expect(db.list('2026-06')[0].category).toBe('Vivienda')
    expect(db.list('2026-06')[0].needs_review).toBe(0)
  })

  it('registrarComercio rechaza un match genérico o muy corto', () => {
    expect(() => db.registrarComercio({ match: 'transferencia', categoria: 'X' })).toThrow()
    expect(() => db.registrarComercio({ match: 'ab', categoria: 'X' })).toThrow()
  })
```

- [ ] **Step 2: Correr (falla)**

Run: `npm test -- db`
Expected: FAIL — `db.clasificarGasto is not a function`.

- [ ] **Step 3: Implementar en `src/db.js`**

```javascript
    clasificarGasto(id, categoria) {
      return (
        sqlite
          .prepare('UPDATE expenses SET category = @categoria, needs_review = 0 WHERE id = @id')
          .run({ id, categoria }).changes > 0
      )
    },

    // Registra un comercio/CUIT aprendido y clasifica los gastos PENDIENTES que matcheen.
    registrarComercio({ match, categoria, alias = null }) {
      const m = (match || '').trim()
      const BLACKLIST = ['transferencia', 'pago', 'compra', 'consumo', 'debito', 'credito']
      if (m.length < 4 || BLACKLIST.includes(m.toLowerCase())) {
        throw new Error('match inválido: debe ser un identificador específico (no genérico ni < 4 caracteres)')
      }
      sqlite
        .prepare('INSERT OR REPLACE INTO comercios_conocidos (match, category, alias) VALUES (@m, @categoria, @alias)')
        .run({ m, categoria, alias })
      const upd = sqlite
        .prepare("UPDATE expenses SET category = @categoria, needs_review = 0 WHERE needs_review = 1 AND upper(merchant) LIKE '%' || upper(@m) || '%'")
        .run({ m, categoria })
      return { inserted: true, pendientesActualizados: upd.changes }
    },
```

- [ ] **Step 4: Correr (pasa los de db)**

Run: `npm test -- db`
Expected: PASS (incluye el `findLearned` de Task 7).

- [ ] **Step 5: Agregar las tools de acción en `src/agent/tools.js`**

Agregar a `definitions`:

```javascript
    {
      name: 'clasificar_gasto',
      description: 'Asigna una categoría a UN gasto puntual (que no se repite). No crea regla. Pasá el id del gasto.',
      input_schema: {
        type: 'object',
        properties: { gasto_id: { type: 'integer' }, categoria: { type: 'string' } },
        required: ['gasto_id', 'categoria'],
      },
    },
    {
      name: 'registrar_comercio',
      description: 'Registra un comercio/CUIT recurrente para que se autoclasifique a futuro y clasifica los pendientes que matcheen. El "match" debe ser específico (CUIT o parte distintiva del comercio), NUNCA genérico como "Transferencia".',
      input_schema: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Identificador específico: CUIT o parte distintiva del comercio' },
          categoria: { type: 'string' },
          alias: { type: 'string', description: 'Nombre lindo opcional, ej. "Alquiler"' },
        },
        required: ['match', 'categoria'],
      },
    },
```

Agregar al `switch` de `execute`:

```javascript
        case 'clasificar_gasto':
          return { ok: db.clasificarGasto(input.gasto_id, input.categoria) }
        case 'registrar_comercio':
          return db.registrarComercio({ match: input.match, categoria: input.categoria, alias: input.alias })
```

- [ ] **Step 6: Test de las tools de acción (agregar a `test/agent/tools.test.js`)**

```javascript
  it('execute(registrar_comercio) guarda y devuelve pendientesActualizados', async () => {
    const r = await tools.execute('registrar_comercio', { match: 'NETFLIX', categoria: 'Suscripciones' })
    expect(r.inserted).toBe(true)
  })
```

- [ ] **Step 7: Correr toda la suite**

Run: `npm test`
Expected: PASS — todo verde (db, tools, agent, ingest, whatsapp, parser, etc.).

- [ ] **Step 8: Commit**

```bash
git add src/db.js src/agent/tools.js test/db.test.js test/agent/tools.test.js
git commit -m "feat: clasificar_gasto + registrar_comercio (acciones del agente, con aprendizaje)"
```

---

# FASE 3 — Notifier proactivo (construido pero INACTIVO)

## Task 10: notifier + disparo en el ingest (feature-flag)

**Files:** Create `src/agent/notifier.js`, Modify `src/routes/ingest.js`, `src/app.js`, `.env.example`, Test `test/agent/notifier.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/agent/notifier.test.js
import { describe, it, expect, vi } from 'vitest'
import { avisarSinClasificar } from '../../src/agent/notifier.js'

const expense = { merchant: 'Transferencia · 999', amount: 1000, currency: 'ARS' }

describe('avisarSinClasificar', () => {
  it('con el flag apagado no manda nada', async () => {
    const send = vi.fn()
    await avisarSinClasificar(expense, { enabled: false, to: '549', send })
    expect(send).not.toHaveBeenCalled()
  })

  it('con el flag prendido manda el aviso por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    await avisarSinClasificar(expense, { enabled: true, to: '549', send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('549')
    expect(send.mock.calls[0][1]).toContain('sin clasificar')
  })
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm test -- agent/notifier`
Expected: FAIL — no encuentra `avisarSinClasificar`.

- [ ] **Step 3: Implementar `src/agent/notifier.js`**

```javascript
// src/agent/notifier.js
import { sendWhatsApp } from '../whatsapp.js'

// Avisa por WhatsApp que entró un gasto sin clasificar.
// INACTIVO por defecto (enabled=false): en sandbox no funciona fuera de la ventana de 24hs.
// Se activa con número productivo + plantilla de utilidad (ver spec).
export async function avisarSinClasificar(expense, { enabled, to, send = sendWhatsApp }) {
  if (!enabled || !to) return
  const sym = expense.currency === 'USD' ? 'U$S ' : '$'
  const texto = `💸 Entró un gasto sin clasificar: ${expense.merchant} ${sym}${expense.amount}. ¿De qué es?`
  try {
    await send(to, texto)
  } catch (e) {
    console.error('notifier falló:', e.message)
  }
}
```

- [ ] **Step 4: Disparar en el ingest** — en `src/routes/ingest.js`, la llamada `const { inserted } = db.insert({...})` ya existe (de Task 8). Justo **después** de esa línea y **antes** del `return res.json(...)`, intercalar este bloque:

```javascript
    if (inserted && needsReview && config.pushEnabled) {
      // No bloquea la respuesta del webhook (no se hace await).
      avisarSinClasificar(
        { merchant: parsed.merchant, amount: parsed.amount, currency: parsed.currency },
        { enabled: true, to: config.notifyWhatsapp }
      )
    }
```

El `return res.json({ inserted, category, currency: parsed.currency, source: parsed.source })` queda igual, después de este bloque.

Agregar el import arriba de `ingest.js`:

```javascript
import { avisarSinClasificar } from '../agent/notifier.js'
```

- [ ] **Step 5: Config en `src/server.js`**

```javascript
  pushEnabled: process.env.WHATSAPP_PUSH_ENABLED === 'true',
  notifyWhatsapp: process.env.NOTIFY_WHATSAPP,
```

- [ ] **Step 6: `.env.example`**

```
# Aviso proactivo cuando entra un gasto sin clasificar. Dejar en false:
# en sandbox no funciona; requiere número productivo + plantilla de utilidad.
WHATSAPP_PUSH_ENABLED=false
```

- [ ] **Step 7: Correr toda la suite**

Run: `npm test`
Expected: PASS — todo verde.

- [ ] **Step 8: Commit y push**

```bash
git add src/agent/notifier.js src/routes/ingest.js src/server.js .env.example test/agent/notifier.test.js
git commit -m "feat: notifier de gastos sin clasificar (inactivo por feature-flag)"
git push origin main
```

---

## Notas de cierre

- **Modelo:** `claude-haiku-4-5` (vos lo elegiste). Haiku 4.5 **no** acepta `effort` ni `thinking` adaptativo → el código no los pasa. Para subir a Sonnet, cambiás `ANTHROPIC_MODEL` (Sonnet sí soporta esos parámetros, pero el código actual no los necesita).
- **API key:** el SDK lee `ANTHROPIC_API_KEY` del entorno; nunca va en el código ni en `config`.
- **Deploy:** al subir al VPS, agregar `ANTHROPIC_API_KEY` (y opcional `ANTHROPIC_MODEL`) al `.env` del VPS, `npm install` (trae `@anthropic-ai/sdk`), `pm2 restart`.
- **Pull (read-only y clasificación) funciona en sandbox hoy.** El **push** (notifier) queda inactivo hasta tener número productivo + plantilla de utilidad.
- **Seguridad:** solo `NOTIFY_WHATSAPP` interactúa; los demás se ignoran. El LLM no escribe SQL libre (solo herramientas parametrizadas) y `registrar_comercio` valida que el match no sea genérico.
