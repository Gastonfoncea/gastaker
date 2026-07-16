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
    'Los consumos con tarjeta de crédito (totalTarjeta*) NO están incluidos en el total del mes:',
    'todavía no salieron de la cuenta, los debita el resumen el mes que viene. Si hay, mencionalos aparte.',
    'Para clasificar: si un gasto es de un comercio/CUIT recurrente usá registrar_comercio (aprende para el futuro);',
    'si es algo puntual que no se repite usá clasificar_gasto. Ante la duda, preguntá.',
    'IMPORTANTE: el "match" de registrar_comercio debe ser un identificador específico (el CUIT de la transferencia,',
    'o una parte distintiva del comercio), NUNCA una palabra genérica como "Transferencia".',
  ].join(' ')
}
