# Gastaker

Tracker automático de gastos: lee los mails de Santander desde Gmail (vía Google
Apps Script) y los anota/categoriza en una web propia.

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
| `WEBHOOK_SECRET` | secreto que valida `/api/ingest` (igual en el Apps Script) |
| `APP_PASSWORD` | contraseña de la web |
| `SESSION_TOKEN` | string aleatorio para la cookie de sesión |

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

## Apps Script (lado Gmail)

Ver `apps-script/Code.gs` y seguir los pasos de su encabezado:
pegar en script.google.com, completar `WEBHOOK_URL` y `WEBHOOK_SECRET`,
autorizar, y poner un trigger de tiempo cada 5 min sobre `sync`.

## Deploys siguientes

```bash
git pull && npm install --omit=dev && pm2 restart gastaker
```

## Agregar reglas de categorías

Editá `src/categories.js` (lista `RULES`) y reiniciá el proceso.
