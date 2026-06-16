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
        case 'clasificar_gasto':
          return { ok: db.clasificarGasto(input.gasto_id, input.categoria) }
        case 'registrar_comercio':
          return db.registrarComercio({ match: input.match, categoria: input.categoria, alias: input.alias })
        default:
          return { error: `herramienta desconocida: ${name}` }
      }
    } catch (e) {
      return { error: e.message }
    }
  }

  return { definitions, execute }
}
