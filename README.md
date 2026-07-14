# Gastaker

Tracker automático de gastos: lee los mails de Santander desde Gmail (vía Google
Apps Script) y los anota/categoriza en una web propia. Multi-usuario: cada cuenta
tiene sus gastos, categorías, Token de Ingesta y número de WhatsApp propios.

## Correr en local

```bash
cp .env.example .env   # editá los valores
npm install
npm test               # corre toda la suite
npm run dev            # levanta en http://127.0.0.1:3000
```

## Variables de entorno (.env)

| Var | Qué es |
|-----|--------|
| `PORT` | puerto interno (Caddy lo expone) |
| `DB_PATH` | ruta del archivo SQLite |
| `KAPSO_API_KEY` | API key de Kapso (envío de WhatsApp) |
| `KAPSO_PHONE_NUMBER_ID` | Phone Number ID del número/sandbox de Kapso |
| `KAPSO_WEBHOOK_SECRET` | secreto que valida la firma del webhook entrante de Kapso |
| `ANTHROPIC_MODEL` | modelo de Claude para el agente (Haiku por defecto) |
| `ANTHROPIC_API_KEY` | API key de Anthropic (la lee el SDK) |

No hay contraseña global: los usuarios entran con email + password. El primer
usuario (admin) se crea con el script de bootstrap (ver abajo) y desde ahí invita
al resto. El secreto de ingesta ya no es global: cada usuario tiene su **Token de
Ingesta** propio (lo ve en Ajustes).

Generá secretos con: `openssl rand -hex 32`

## Deploy en el VPS

1. **Instalar Node** (una vez):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Traer el código y dependencias:**
   ```bash
   git clone <tu-repo> gastaker && cd gastaker
   npm install --omit=dev
   cp .env.example .env   # editá con secretos reales
   ```
3. **Dejar el proceso prendido con pm2:**
   ```bash
   sudo npm install -g pm2
   pm2 start src/server.js --name gastaker
   pm2 save
   pm2 startup   # seguí la instrucción que imprime (arranca al bootear)
   ```
4. **Firewall (UFW):**
   ```bash
   sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
   sudo ufw enable
   ```
   El puerto 3000 queda cerrado al público: la app escucha solo en localhost.
5. **Exponer con HTTPS (Caddy + dominio):**
   - Apuntá un (sub)dominio a la IP del VPS (registro A en tu proveedor de DNS).
   - Instalá Caddy: https://caddyserver.com/docs/install
   - `/etc/caddy/Caddyfile`:
     ```
     gastaker.tudominio.com {
         reverse_proxy localhost:3000
     }
     ```
   - `sudo systemctl reload caddy` → Caddy saca el certificado HTTPS solo.
   - (Alternativa sin dominio: `sudo ufw allow 3000` y entrá por `http://IP:3000`,
     pero sin HTTPS. Solo para probar.)

## Primer usuario y bootstrap

El alta directa de usuarios es solo por script; el resto entra por invitación.

- **Deploy nuevo (o al migrar a la versión multi-usuario):** creá el usuario admin
  y adoptá los datos preexistentes (si los hubiera) con:
  ```bash
  node scripts/bootstrap-user.js tu-email@ejemplo.com "tu-clave-larga"
  ```
  El script es idempotente (se puede correr de nuevo sin duplicar nada), asigna al
  admin todos los gastos/categorías que existían de la etapa single-user, e imprime
  el **Token de Ingesta** para pegar en el Apps Script. El usuario del bootstrap es
  el **único admin**: es quien puede generar invitaciones.
- **Reset de password (emergencias):**
  ```bash
  node scripts/reset-password.js tu-email@ejemplo.com "nueva-clave"
  ```

## Invitar a alguien

Como admin, entrá a **Ajustes → Invitar amigo**: genera un link de un solo uso
(vence en 7 días). Pasáselo a la persona; se registra con email + password en ese
link y queda logueada. Los usuarios invitados no pueden, a su vez, invitar a otros.

## Apps Script (lado Gmail)

Ver `apps-script/Code.gs` y seguir los pasos de su encabezado: pegar en
script.google.com, completar `WEBHOOK_URL` y el `INGEST_TOKEN` (tu Token de Ingesta,
que copiás desde **Ajustes** en la web), autorizar, y poner un trigger de tiempo
cada 5 min sobre `sync`. Cada usuario configura su propio Apps Script con su token.

## Deploys siguientes

```bash
git pull && npm install --omit=dev && pm2 restart gastaker
```

> Al actualizar a la versión multi-usuario por primera vez, corré una vez
> `node scripts/bootstrap-user.js …` (ver arriba) para adoptar tus datos previos.

## Agregar reglas de categorías

Editá `src/categories.js` (lista `RULES`) y reiniciá el proceso.
