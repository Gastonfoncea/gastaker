# Agente de gastos por WhatsApp — Diseño

**Fecha:** 2026-06-16
**Estado:** Diseño para aprobar → plan de implementación

## Problema

Hoy gastaker recibe los gastos (Gmail → ingest → SQLite) y los muestra en la web. Falta:
1. **Consultar los gastos en lenguaje natural por WhatsApp** ("¿cuánto gasté en comida?").
2. **Resolver los gastos que no se autoclasifican** (transferencias a un CUIT, débitos sin comercio claro): que el usuario le diga al bot qué son, y que el sistema **aprenda** para no volver a preguntar.

## Objetivo

Un agente conversacional por WhatsApp (sobre el canal Kapso ya armado) que:
- Responde preguntas consultando la base (read-only).
- Permite clasificar gastos puntuales y **registrar comercios/CUITs recurrentes** que se autoclasifican a futuro.
- Avisa proactivamente cuando entra un gasto sin clasificar — **construido pero inactivo** hasta tener número productivo + plantilla (limitación de las 24hs de WhatsApp).

## No-objetivos (YAGNI)

- Recategorización masiva del histórico (decisión del usuario: no vale la pena).
- Memoria persistente entre reinicios (la conversación vive en RAM; se pierde en restart, es aceptable).
- Multiusuario (solo el número del dueño interactúa).
- Push proactivo activo en sandbox (requiere plantilla de producción; queda dormido).

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Cerebro | Claude **Haiku** (configurable por env), vía SDK de Anthropic, tool-calling en nuestro backend |
| Memoria | En **RAM**, `Map` por número de WhatsApp, **reset a los 30 min** de inactividad |
| Capacidades | Consulta (read) + acciones (clasificar) |
| Retroactivo | No en masa; los desconocidos quedan **pendientes** y se resuelven conversando |
| Seguridad | Solo el número `NOTIFY_WHATSAPP` puede interactuar; el resto se ignora |
| Push proactivo | Construido pero **inactivo** (`WHATSAPP_PUSH_ENABLED=false`); se activa con producción + plantilla |

## Arquitectura

`/api/whatsapp` deja de hacer el eco y llama al **agente**. El agente orquesta Claude + herramientas sobre el SQLite existente (vía `db.js`). El `ingest` aprende de la tabla de comercios y dispara el aviso (cuando esté activo).

```
WhatsApp ─► Kapso ─► /api/whatsapp ─► agente (Claude + tools) ─► db.js (SQL) ─► SQLite
                                          │
                                     memoria RAM (por número, 30 min)

Gmail ─► ingest ─► (regla estática → comercio aprendido → default + needs_review) ─► SQLite
                                          │ (si needs_review y push activo)
                                     notifier ─► WhatsApp "gasto sin clasificar"
```

## Componentes (archivos)

```
src/agent/
├── agent.js      # loop de tool-calling: arma mensajes, llama a Claude, ejecuta tools, devuelve texto
├── tools.js      # definiciones de las herramientas + su implementación (llaman a db.js)
├── memory.js     # historial en RAM por número, expira a 30 min
└── notifier.js   # aviso de gasto sin clasificar (feature-flag, inactivo por defecto)
src/db.js         # + tabla comercios_conocidos, columna needs_review, funciones de consulta y clasificación, learnedLookup
src/routes/whatsapp.js  # reemplaza el eco por el agente; solo número autorizado
src/routes/ingest.js    # usa learnedLookup, setea needs_review, dispara notifier
.env(.example)    # ANTHROPIC_API_KEY, ANTHROPIC_MODEL, WHATSAPP_PUSH_ENABLED
```

## Datos / esquema

**Tabla `expenses`** — agregar columna:
- `needs_review INTEGER NOT NULL DEFAULT 0` — 1 si el gasto entró sin clasificar (cayó en el default).

**Tabla nueva `comercios_conocidos`** (lo aprendido):
```sql
CREATE TABLE comercios_conocidos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match       TEXT NOT NULL UNIQUE,   -- substring identificador: comercio o CUIT
  category    TEXT NOT NULL,
  alias       TEXT,                    -- nombre lindo opcional ("Alquiler")
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Lógica de categorización en el ingest** (orden):
1. `categorize(merchant)` por reglas estáticas (`categories.js`).
2. Si no matcheó: `learnedLookup(merchant)` — busca un `comercios_conocidos.match` contenido en el `merchant` del gasto.
3. Si tampoco: cae en el **default** (`'Otros'` para consumo, `'Transferencias'` para transferencia) y se setea **`needs_review = 1`**.

Si matcheó (estática o aprendida) → `needs_review = 0`.

## Herramientas del agente

El LLM elige la herramienta y completa los parámetros; el backend corre el SQL en `db.js`. El modelo **no escribe SQL libre**.

**Consulta (read-only):**
- `resumen_mes(mes)` → total ARS, total USD, desglose por categoría. `mes` = `'YYYY-MM'`.
- `listar_gastos(mes, categoria?, comercio?)` → lista de movimientos (acotada).
- `comparar_meses(mesA, mesB)` → totales de cada mes.
- `pendientes()` → gastos con `needs_review = 1` (los desconocidos).

**Acción (son DOS distintas, mapean a las dos tablas):**
- `clasificar_gasto(gasto_id, categoria)` → setea la categoría de **un gasto puntual** y `needs_review = 0`. **No crea regla.** Para one-offs.
- `registrar_comercio(match, categoria, alias?)` → inserta en `comercios_conocidos` (la regla aprendida) **y** aplica a los gastos **pendientes** que matcheen (`needs_review = 1 AND merchant LIKE '%match%'` → set categoría + `needs_review = 0`). Los futuros se autoclasifican vía `learnedLookup`. Para negocios/CUITs recurrentes.

El **system prompt** guía al agente: si el gasto parece recurrente (CUIT, comercio con nombre estable) → `registrar_comercio`; si es claramente único → `clasificar_gasto`; ante la duda, pregunta. Responde en español, breve.

> **Crítico:** el `match` de `registrar_comercio` debe ser un **identificador específico** — el CUIT en transferencias (ej. `20520522523`), o una parte distintiva del comercio (ej. `APPLECOMBILL`). **Nunca** una palabra genérica como `"Transferencia"` (matchearía todas). El prompt instruye esto explícitamente, y como salvaguarda el backend rechaza `match` de menos de 4 caracteres o que sea una palabra de la lista negra (`transferencia`, `pago`, etc.).

## Memoria (RAM)

- `Map<numero, { mensajes: [...], lastActiveAt }>`.
- En cada mensaje entrante: si pasaron > 30 min desde `lastActiveAt`, se descarta el historial (hilo nuevo). Si no, se agrega al historial.
- Se guarda historial usuario + asistente (incluyendo los resultados de tools) para que los follow-ups y las respuestas a "¿de qué es este gasto?" tengan contexto.
- Se pierde en reinicio del proceso (aceptable).

## Notifier (push) — construido pero INACTIVO

- En `ingest`, tras insertar un gasto con `needs_review = 1`: si `WHATSAPP_PUSH_ENABLED === 'true'`, llamar `notifier.avisarSinClasificar(expense)` → `sendWhatsApp(NOTIFY_WHATSAPP, "💸 Gasto sin clasificar: <comercio> $<monto>. ¿De qué es?")`.
- Por defecto `WHATSAPP_PUSH_ENABLED=false` → no envía nada (en sandbox no funcionaría fuera de la ventana de 24hs).
- Activación futura: número productivo + **plantilla de utilidad** aprobada por Meta (gratis en mensajes). El texto del notifier se adaptará a la plantilla en ese momento.

## Seguridad

- En `/api/whatsapp`, tras validar la firma HMAC: comparar `message.from` con `NOTIFY_WHATSAPP` (normalizado). Si no coincide → responder 200 y **no hacer nada** (ignorar; son finanzas personales).
- `ANTHROPIC_API_KEY` y demás secretos en `.env`, nunca en el repo.

## Flujo end-to-end (pull, funciona en sandbox hoy)

```
Vos: "¿qué quedó sin clasificar?"
  → agente: pendientes() → "Tenés 1: transferencia a 20520522523 por $1.000"
Vos: "es el alquiler"
  → agente (con memoria sabe de qué gasto hablás) → registrar_comercio('20520522523','Vivienda','Alquiler')
  → "Listo, lo marqué como Vivienda (Alquiler). Las próximas se clasifican solas."
```

## Manejo de errores

- Mensaje de número no autorizado → ignorar (200, sin respuesta).
- Falla la API de Claude → responder "Ups, no pude procesar eso ahora, probá de nuevo".
- Una tool lanza error → se le devuelve el error a Claude para que lo explique en la respuesta.
- El handler responde 200 rápido a Kapso (el envío de la respuesta es una sola llamada, dentro de tiempo).

## Testing

- **Tools / db**: tests de cada consulta y de `clasificar_gasto` / `registrar_comercio` contra una DB en memoria (incluido: `registrar_comercio` setea pendientes que matcheen; `learnedLookup` se usa en el ingest después).
- **Ingest**: un gasto desconocido entra con `needs_review = 1`; tras `registrar_comercio`, el siguiente igual entra con `needs_review = 0`.
- **Agente**: test del loop con un cliente de Claude **mockeado** (sin pegarle a la API real) — verifica que ejecuta la tool pedida y devuelve la respuesta final.
- **Seguridad**: un número no autorizado se ignora.
- **Notifier**: con flag off no envía; con flag on llama a `sendWhatsApp` (mockeado).

## Orden de construcción (fases)

1. **Fase 1 — Agente de consulta:** `memory.js`, `tools.js` (solo read tools), `agent.js` (loop), seguridad, y `whatsapp.js` usando el agente. Preguntarle funciona.
2. **Fase 2 — Aprendizaje y clasificación:** columna `needs_review`, tabla `comercios_conocidos`, `learnedLookup` + integración en `ingest`, tools `clasificar_gasto` y `registrar_comercio`. El pull de clasificación funciona.
3. **Fase 3 — Notifier (inactivo):** `notifier.js` + disparo en `ingest` detrás de `WHATSAPP_PUSH_ENABLED`.

## Dependencias

- Nueva: `@anthropic-ai/sdk` (maneja el loop de tool-use). Resto: lo que ya hay.
- Env nuevas: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default Haiku), `WHATSAPP_PUSH_ENABLED` (default `false`).
