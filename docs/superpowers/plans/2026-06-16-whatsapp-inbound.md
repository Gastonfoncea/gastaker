# WhatsApp Inbound (webhook) + Deploy con dominio/HTTPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recibir mensajes de WhatsApp en gastaker — Kapso postea el mensaje entrante a `POST /api/whatsapp`, el backend valida la firma HMAC, lee el mensaje y (como primer hito) responde un "Recibí: …" por WhatsApp. Incluye exponer el servidor con dominio + HTTPS (Caddy) para que el webhook sea alcanzable.

**Architecture:** Una ruta nueva `/api/whatsapp` en el mismo Express (protegida por firma HMAC, no por la cookie). Reutiliza `sendWhatsApp` para responder. En el VPS, Caddy hace HTTPS automático y reverse-proxy al `:3000`. El webhook de Kapso apunta a `https://gastaker.xyz/api/whatsapp`.

**Tech Stack:** Node.js (ESM), Express, `crypto` (nativo, para HMAC), Vitest + Supertest. Caddy + DNS en el VPS. Kapso como canal de WhatsApp.

**Datos concretos del entorno:**
- Dominio: `gastaker.xyz` · IP del VPS: `51.210.107.197` · usuario SSH: `ubuntu` · repo: `github.com/Gastonfoncea/gastaker`
- Kapso phone_number_id (sandbox): `597907523413541`
- Payload entrante de Kapso (evento `whatsapp.message.received`): remitente en `message.from`, texto en `message.text.body`.
- Firma: header `X-Webhook-Signature` = `HMAC-SHA256(JSON.stringify(payload), secret)` en hex, **sin** prefijo.

---

## File Structure

```
src/
├── whatsapp.js          # + verifyKapsoSignature() (junto a sendWhatsApp)
├── routes/
│   └── whatsapp.js      # NUEVO: whatsappRouter() — recibe el webhook
├── app.js               # + montar /api/whatsapp + trust proxy
└── server.js            # + kapsoWebhookSecret en config
test/
├── whatsapp.test.js     # NUEVO: test de verifyKapsoSignature
└── routes/
    └── whatsapp.test.js # NUEVO: test del router (firma válida/ inválida)
.env.example             # + KAPSO_WEBHOOK_SECRET
```

Tareas de **código** (1-3): local, TDD. Tareas de **servidor** (4-8): se ejecutan en el VPS / paneles, con comandos exactos.

---

## Task 1: Verificación de firma HMAC

**Files:**
- Modify: `src/whatsapp.js`
- Test: `test/whatsapp.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/whatsapp.test.js
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyKapsoSignature } from '../src/whatsapp.js'

const secret = 'test-secret'
const payload = { message: { from: '549', text: { body: 'hola' } } }
const sign = (p, s) => crypto.createHmac('sha256', s).update(JSON.stringify(p)).digest('hex')

describe('verifyKapsoSignature', () => {
  it('acepta una firma válida', () => {
    expect(verifyKapsoSignature(payload, sign(payload, secret), secret)).toBe(true)
  })
  it('rechaza una firma de otro secreto', () => {
    expect(verifyKapsoSignature(payload, sign(payload, 'otro'), secret)).toBe(false)
  })
  it('rechaza si falta la firma o el secreto', () => {
    expect(verifyKapsoSignature(payload, '', secret)).toBe(false)
    expect(verifyKapsoSignature(payload, 'abc', '')).toBe(false)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- whatsapp`
Expected: FAIL — `verifyKapsoSignature is not a function`.

- [ ] **Step 3: Implementar en `src/whatsapp.js`** (agregar al final, dejando `sendWhatsApp` como está)

```javascript
import crypto from 'node:crypto'

// Verifica la firma HMAC-SHA256 que Kapso manda en el header X-Webhook-Signature.
// Kapso firma JSON.stringify(payload) con tu secreto, en hex (sin prefijo).
export function verifyKapsoSignature(payload, signature, secret) {
  if (!signature || !secret) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
```

> Nota: `import crypto` va arriba del archivo, junto a los otros imports (o al inicio). No dupliques imports si ya hubiera uno.

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- whatsapp`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp.js test/whatsapp.test.js
git commit -m "feat: verifyKapsoSignature (validación HMAC del webhook de WhatsApp)"
```

---

## Task 2: Ruta del webhook `/api/whatsapp`

**Files:**
- Create: `src/routes/whatsapp.js`
- Test: `test/routes/whatsapp.test.js`

- [ ] **Step 1: Escribir el test que falla**

```javascript
// test/routes/whatsapp.test.js
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { whatsappRouter } from '../../src/routes/whatsapp.js'

const SECRET = 'wh-secret'
const sign = (p) => crypto.createHmac('sha256', SECRET).update(JSON.stringify(p)).digest('hex')

function makeApp(send) {
  const app = express()
  app.use(express.json())
  app.use('/api/whatsapp', whatsappRouter({ config: { kapsoWebhookSecret: SECRET }, send }))
  return app
}

const payload = {
  message: { from: '5493513071645', type: 'text', text: { body: 'hola bot' } },
}

describe('POST /api/whatsapp', () => {
  it('con firma válida: responde 200 y contesta por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', sign(payload))
      .send(payload)
    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledWith('5493513071645', 'Recibí: hola bot')
  })

  it('con firma inválida: 401 y no contesta', async () => {
    const send = vi.fn()
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', 'firma-mala')
      .send(payload)
    expect(res.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('mensaje sin texto: 200 y no contesta', async () => {
    const send = vi.fn()
    const noText = { message: { from: '549', type: 'image' } }
    const res = await request(makeApp(send))
      .post('/api/whatsapp')
      .set('X-Webhook-Signature', sign(noText))
      .send(noText)
    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- routes/whatsapp`
Expected: FAIL — no encuentra `whatsappRouter`.

- [ ] **Step 3: Implementar `src/routes/whatsapp.js`**

```javascript
// src/routes/whatsapp.js
import express from 'express'
import { verifyKapsoSignature, sendWhatsApp } from '../whatsapp.js'

// Router del webhook entrante de Kapso. `send` se inyecta para testear sin red.
export function whatsappRouter({ config, send = sendWhatsApp }) {
  const router = express.Router()

  router.post('/', async (req, res) => {
    const signature = req.get('X-Webhook-Signature')
    if (!verifyKapsoSignature(req.body, signature, config.kapsoWebhookSecret)) {
      return res.status(401).json({ error: 'firma inválida' })
    }

    const msg = req.body?.message
    const from = msg?.from
    const text = msg?.text?.body

    // Hito de prueba: eco. (Más adelante acá va el agente.)
    if (from && text) {
      try {
        await send(from, `Recibí: ${text}`)
      } catch (e) {
        console.error('No pude responder por WhatsApp:', e.message)
      }
    }

    return res.json({ ok: true })
  })

  return router
}
```

> Nota sobre la firma: Kapso firma `JSON.stringify(payload)` y nosotros verificamos `JSON.stringify(req.body)`. Esto matchea si el orden de las claves se preserva (lo hace Express al parsear). Si en producción la firma fallara siempre, el plan B es capturar el body crudo con `express.json({ verify: (req,_res,buf) => { req.rawBody = buf } })` y firmar sobre `req.rawBody`. Por ahora seguimos la receta oficial de Kapso.

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- routes/whatsapp`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/whatsapp.js test/routes/whatsapp.test.js
git commit -m "feat: ruta /api/whatsapp (webhook entrante con eco de prueba)"
```

---

## Task 3: Montar la ruta + trust proxy + config

**Files:**
- Modify: `src/app.js`
- Modify: `src/server.js`
- Modify: `.env.example`

- [ ] **Step 1: Montar el router en `src/app.js`**

Agregar el import junto a los otros routers:

```javascript
import { whatsappRouter } from './routes/whatsapp.js'
```

Dentro de `createApp`, **al inicio** (antes de las otras rutas), confiar en el proxy (para que `req.secure` sea correcto detrás de Caddy y la cookie de sesión quede `secure` en producción):

```javascript
  app.set('trust proxy', 1)
```

Y montar la ruta junto a `/api/ingest` (el webhook NO lleva la cookie de auth; se protege por firma):

```javascript
  app.use('/api/whatsapp', whatsappRouter({ config }))
```

- [ ] **Step 2: Agregar `kapsoWebhookSecret` a la config en `src/server.js`**

En el objeto `config` de `src/server.js`, agregar:

```javascript
  kapsoWebhookSecret: requireEnv('KAPSO_WEBHOOK_SECRET'),
```

(Queda junto a `webhookSecret`, `appPassword`, `sessionToken`.)

- [ ] **Step 3: Documentar la variable en `.env.example`**

Agregar al final de la sección de WhatsApp:

```
# Secreto para validar la firma del webhook entrante de Kapso (X-Webhook-Signature).
# Debe coincidir EXACTO con el secreto configurado en el webhook de Kapso.
KAPSO_WEBHOOK_SECRET=un-secreto-largo-y-aleatorio
```

- [ ] **Step 4: Correr toda la suite**

Run: `npm test`
Expected: PASS — todo verde (incluye los nuevos de Task 1 y 2).

- [ ] **Step 5: Probar el arranque local (con la var nueva)**

Agregá `KAPSO_WEBHOOK_SECRET=local-test` a tu `.env` local. Luego:
Run: `node --env-file=.env src/server.js`
Expected: imprime `Gastaker escuchando en http://127.0.0.1:3000` (no debe abortar por falta de env). Cortá con Ctrl+C.

- [ ] **Step 6: Commit y push**

```bash
git add src/app.js src/server.js .env.example
git commit -m "feat: montar /api/whatsapp + trust proxy + KAPSO_WEBHOOK_SECRET"
git push origin main
```

---

## Task 4: DNS — apuntar el dominio al VPS

**Dónde:** panel DNS de tu registrador de `gastaker.xyz` (no es código).

- [ ] **Step 1: Crear el registro A**

En la zona DNS de `gastaker.xyz`, creá un registro:
```
Tipo: A   |   Host/Nombre: @   |   Valor: 51.210.107.197   |   TTL: automático
```
(`@` = el dominio raíz `gastaker.xyz`.)

- [ ] **Step 2: Verificar la propagación**

Desde tu Mac (esperá unos minutos tras crearlo):
Run: `dig +short gastaker.xyz`
Expected: imprime `51.210.107.197`. (Si no, esperá un rato y reintentá.)

---

## Task 5: Caddy en el VPS (HTTPS + reverse proxy)

**Dónde:** por SSH en el VPS (`ssh ubuntu@51.210.107.197`).

- [ ] **Step 1: Abrir el firewall para web**

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw status
```
Expected: 80 y 443 con `ALLOW`.

- [ ] **Step 2: Instalar Caddy**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```
Expected: imprime una versión de Caddy (ej. `v2.x`).

- [ ] **Step 2b (solo si tu app NO está corriendo aún en el VPS):** seguí primero el Task 6 (deploy) y volvé acá. Caddy necesita que algo escuche en `localhost:3000` para reenviarle.

- [ ] **Step 3: Configurar el Caddyfile**

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
gastaker.xyz {
    reverse_proxy localhost:3000
}
EOF
sudo systemctl reload caddy
```

- [ ] **Step 4: Verificar HTTPS**

Esperá ~30s (Caddy saca el certificado solo) y desde tu Mac:
Run: `curl -sI https://gastaker.xyz/ | head -1`
Expected: `HTTP/2 200` (la web de gastaker servida con candado). Abrila en el navegador: `https://gastaker.xyz/`.

---

## Task 6: Deploy de la versión nueva al VPS

**Dónde:** por SSH en el VPS, dentro de la carpeta del repo.

- [ ] **Step 1: Traer el código y dependencias**

```bash
cd gastaker
git pull
npm install --omit=dev
```
Expected: baja todos los cambios (refactor de sources, currency, whatsapp, etc.) sin errores. (No hay dependencias nuevas: WhatsApp usa `fetch` y `crypto` nativos.)

- [ ] **Step 2: Setear las variables de entorno de WhatsApp en el `.env` del VPS**

Editá el `.env` del VPS (`nano .env`) y agregá (con tus valores reales):
```
KAPSO_API_KEY=<tu api key de kapso>
KAPSO_PHONE_NUMBER_ID=597907523413541
KAPSO_WEBHOOK_SECRET=<el mismo secreto que vas a poner en Kapso, Task 7>
NOTIFY_WHATSAPP=5493513071645
```
Generá el secreto con: `openssl rand -hex 32`. **No** lo commitees (el `.env` está en `.gitignore`).

- [ ] **Step 3: Reiniciar el proceso**

```bash
pm2 restart gastaker
pm2 logs gastaker --lines 20 --nostream
```
Expected: arranca sin errores y loguea `Gastaker escuchando en http://127.0.0.1:3000`.

---

## Task 7: Configurar el webhook en Kapso

**Dónde:** dashboard de Kapso → **Integrations → Webhooks → Platform webhooks → Add Webhook** (o vía API).

- [ ] **Step 1: Crear el webhook**

- **URL:** `https://gastaker.xyz/api/whatsapp`
- **Secret:** el mismo valor que pusiste en `KAPSO_WEBHOOK_SECRET` (Task 6, Step 2).
- **Evento:** suscribir `whatsapp.message.received`.
- Guardar.

- [ ] **Step 2 (alternativa por API):** si preferís API, desde tu Mac (con la key en el `.env` local):

```bash
node --env-file=.env -e '
const k = process.env.KAPSO_API_KEY;
const r = await fetch("https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/597907523413541/webhooks", {
  method: "POST",
  headers: { "X-API-Key": k, "Content-Type": "application/json" },
  body: JSON.stringify({
    url: "https://gastaker.xyz/api/whatsapp",
    secret: process.env.KAPSO_WEBHOOK_SECRET,
    events: ["whatsapp.message.received"]
  })
});
console.log(r.status, await r.text());
'
```
Expected: 200/201 con el webhook creado. (Si el esquema del body difiere, usá el dashboard del Step 1.)

---

## Task 8: Prueba end-to-end

- [ ] **Step 1: Mandarle un mensaje al bot**

Desde tu WhatsApp (`5493513071645`), escribíle al número del sandbox de Kapso: por ejemplo **"cuánto gasté"** (cualquier texto). Esto además mantiene abierta la ventana de 24hs.

- [ ] **Step 2: Verificar la respuesta**

Expected: en segundos te llega de vuelta **"Recibí: cuánto gasté"**. Eso confirma el loop inbound→backend→outbound completo.

- [ ] **Step 3 (si no llega): diagnóstico**

En el VPS:
```bash
pm2 logs gastaker --lines 40 --nostream
```
- Si ves un 401/"firma inválida" → el `KAPSO_WEBHOOK_SECRET` del `.env` no coincide con el secreto del webhook en Kapso. Igualalos.
- Si no llega ningún POST → revisá en Kapso que el webhook esté activo y apunte a `https://gastaker.xyz/api/whatsapp`; y que `dig +short gastaker.xyz` dé la IP del VPS.
- Si el POST llega pero la respuesta no sale → revisá que `KAPSO_API_KEY` y `KAPSO_PHONE_NUMBER_ID` estén en el `.env` del VPS y que la sesión del sandbox esté activa (mandá de nuevo cualquier mensaje al bot).

---

## Notas de cierre

- **Sin dependencias nuevas:** todo usa `fetch` y `crypto` nativos de Node.
- **El webhook NO usa la cookie de auth** — se protege por la firma HMAC. Por eso se monta como `/api/whatsapp` sin `requireAuth` (igual que `/api/ingest`).
- **El "Recibí: …" es un hito de prueba.** El próximo paso (otro plan) es reemplazar ese eco por el **agente** (Claude + tools sobre SQLite) que responde de verdad "¿cuánto gasté?".
- **Notificaciones proactivas** (que el bot avise sin que escribas) quedan fuera: fuera de las 24hs requieren plantilla aprobada (no sandbox).
