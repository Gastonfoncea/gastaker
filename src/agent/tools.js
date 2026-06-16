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
