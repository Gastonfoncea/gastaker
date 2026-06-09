# Guía de deploy para principiantes — el caso Gastaker

> Resumen teórico de **todo lo que hicimos** para poner Gastaker online en un VPS,
> con HTTPS y conectado a Gmail. Pensado para estudiar de cero, con analogías.
> Si entendés este documento, entendés cómo se publica casi cualquier web.

---

## 0. El objetivo, en una frase

Teníamos el **código** de una app (Gastaker) y queríamos que cualquiera pudiera
entrar desde internet a `https://gastaker.xyz`, de forma **segura** (con candado),
y que la app recibiera automáticamente los **mails de gastos de Santander**.

Para lograrlo tuvimos que resolver, por capas, estos problemas:

1. Hacer que el código **corra** y **siga prendido** en una máquina.
2. Darle un **nombre** (dominio) que apunte a esa máquina.
3. Exponerlo a internet **con seguridad** (firewall + HTTPS).
4. Conectarlo con **Gmail** para que ingrese los datos solo.

---

## 1. Conceptos base (los ladrillos)

### 1.1 Servidor / VPS
Un **servidor** es simplemente una computadora **prendida 24/7** y conectada a
internet, esperando pedidos. Un **VPS** (Virtual Private Server) es un servidor
**alquilado** en la nube (el nuestro es de OVH). Vos entrás a administrarlo de
forma remota; no es una caja física en tu casa, pero se comporta igual.

### 1.2 Localhost vs. internet
- **localhost** (o `127.0.0.1`) = "yo mismo", la propia máquina. Algo en localhost
  **solo lo ve la máquina**, nadie de afuera.
- **Internet** = el resto del mundo, que llega a tu máquina por su **IP pública**.

Una idea central de todo esto: muchas cosas viven en localhost (privadas) y vos
**elegís con cuidado qué exponer** al mundo.

### 1.3 Puertos (¡concepto clave!)
Una misma máquina puede correr **muchos programas que escuchan a la vez**. Para no
mezclarse, cada uno usa un **puerto**: un número que identifica "por dónde" habla
ese programa. Pensalos como **ventanillas numeradas** del mismo edificio.

Reglas de oro:
- **Un puerto, un solo programa a la vez.** Si dos quieren el mismo, explota
  (el famoso error `EADDRINUSE`, que nos pasó con el 3000).
- El programa **elige su puerto en su configuración** (no es mágico). Gastaker
  escucha en el **3001** porque lo pusimos en su `.env` (`PORT=3001`).

Puertos "famosos" que vas a ver siempre:

| Puerto | Para qué |
|--------|----------|
| 22  | SSH (administración remota) |
| 80  | HTTP (web sin cifrar) |
| 443 | HTTPS (web cifrada) |
| 3000, 3001, 8080… | puertos "de apps", elegidos por vos |

### 1.4 Carpeta ≠ proceso ≠ puerto
Tres cosas distintas que se confunden:
- **Carpeta**: el código **quieto** en el disco (`/home/ubuntu/lab/gastaker`).
- **Proceso**: el código **corriendo** (Node ejecutando ese código).
- **Puerto**: el número donde ese proceso **escucha** mientras está vivo (3001).

La carpeta no "tiene" un puerto. Cuando ejecutás el código nace un **proceso**, y
ese proceso **agarra** el puerto. Si apagás la app, el puerto **se libera**.

---

## 2. Hacer correr la app

### 2.1 Node y npm
- **Node.js** es el motor que ejecuta JavaScript **fuera del navegador** (en el server).
- **npm** es su gestor de paquetes: baja las **dependencias** (librerías que la app
  necesita) listadas en `package.json`. Eso hace `npm install` → crea la carpeta
  `node_modules`.

### 2.2 Variables de entorno (`.env`)
Son **valores de configuración y secretos** que NO van escritos en el código (para
no subirlos a internet). Viven en un archivo `.env` que **se mantiene privado**
(está en `.gitignore`, nunca se sube al repo).

Las 5 de Gastaker:

| Variable | Para qué | ¿La usás vos? |
|----------|----------|----------------|
| `PORT` | en qué puerto escucha la app (3001) | no, interno |
| `DB_PATH` | dónde se guarda el archivo de la base | no, interno |
| `APP_PASSWORD` | **tu clave para entrar a la web** | sí, la tipeás |
| `WEBHOOK_SECRET` | "santo y seña" para que Gmail pueda mandar datos | la copiás al Apps Script |
| `SESSION_TOKEN` | valor de la cookie que prueba que ya te logueaste | no, interno |

> ⚠️ Dato útil: Node **no lee el `.env` solo**. Hay que decírselo con
> `node --env-file=.env`. Esto nos causó un crash al principio (la app no
> encontraba las variables) hasta que lo arreglamos.

### 2.3 Process manager (pm2)
Si corrés la app a mano y cerrás la terminal, **el proceso muere**. Un **process
manager** como **pm2** resuelve eso:
- La mantiene **prendida 24/7**.
- La **revive** si se cae.
- La **arranca sola** cuando el server se reinicia.

Comando típico: `pm2 start src/server.js --name gastaker`.

---

## 3. El nombre: DNS y dominios

### 3.1 IP (la dirección numérica)
Toda máquina en internet tiene una **IP**. Hay dos tipos:
- **IPv4**: `51.210.107.197` (la clásica).
- **IPv6**: `2001:41d0:305:2100::607a` (la nueva, más larga). Nuestro server tiene
  las dos.

Los humanos no memorizamos números → por eso existe el DNS.

### 3.2 DNS = la agenda de internet
El **DNS** traduce un **nombre** a una **IP**. Es la "agenda de contactos":

```
gastaker.xyz  →  51.210.107.197
```

- Un **registro A** = "este nombre apunta a esta IPv4".
- Un **registro AAAA** = lo mismo pero para IPv6.
- El DNS **no sabe nada de puertos**: solo nombre → IP.

### 3.3 Dominio, nameservers y propagación
- Comprás un **dominio** en un registrador (nosotros: **Namecheap**).
- Configurás sus **registros** (los A apuntando a tu IP).
- Los **nameservers** son los servidores que "publican" tu agenda. Si usás
  "Namecheap BasicDNS", los maneja Namecheap.
- **Propagación**: los cambios de DNS **tardan** en verse en todo el mundo (de
  minutos a horas), porque los resolvers **cachean** los valores un rato.

### 3.4 El "parking record" (el problema que tuvimos)
Namecheap dejaba por defecto un **"URL Redirect Record"** que metía una IP de
**parking** (`162.255.119.247`) en nuestro dominio. Resultado: el dominio resolvía
a **dos** IPs (la nuestra + la de parking). Hubo que **borrarlo**, porque esa IP
extra rompía la emisión del certificado HTTPS.

> Truco que usamos: para saber si un cambio de DNS ya está aplicado **sin cache**,
> se consulta **directo al nameserver autoritativo**:
> `dig @dns1.registrar-servers.com gastaker.xyz`

---

## 4. Exponer a internet con seguridad

### 4.1 Firewall (UFW)
Un **firewall** decide **qué puertos** del server están abiertos al mundo. Por
defecto, lo cerramos **todo** y abrimos solo lo necesario. Con **UFW** abrimos:

| Puerto | Por qué | ¿Para quién? |
|--------|---------|--------------|
| 22 (SSH)  | administrar el server | **vos** (mantenimiento) |
| 80 (HTTP) | sacar/renovar el certificado + redirigir a https | trámite técnico |
| 443 (HTTPS) | la web en sí, cifrada | los visitantes |

Punto importante: **abrir el puerto 22 no es para los visitantes**, es **tu puerta
de mantenimiento**. Si lo cerrás y activás el firewall, **te quedás afuera del
server**. Por eso siempre se abre **antes** de activar UFW.

Y abrir un puerto **no significa "entra cualquiera"**: la conexión llega a la
puerta, pero SSH igual **te pide la llave** (clave o key). Abrir el puerto = se
puede tocar el timbre; autenticación = adentro entrás solo vos.

### 4.2 HTTP vs HTTPS (y por qué importa)
- **HTTP** (puerto 80): los datos viajan **en texto plano**. Cualquiera en el
  camino (wifi, ISP) **puede leer** tu contraseña. Inseguro.
- **HTTPS** (puerto 443): los datos viajan **cifrados** con **TLS**. Un espía solo
  ve basura ilegible. Es lo que querés para un login.

Por eso, **regla de oro: nunca te logueás por `http://`, solo por `https://`**.

### 4.3 Certificados y Let's Encrypt
Para hacer HTTPS hace falta un **certificado** que pruebe que el dominio es tuyo.
**Let's Encrypt** los da **gratis y automáticos**. El server demuestra que controla
el dominio (por eso el DNS tiene que apuntar bien y el puerto 80 estar abierto), y
recibe el certificado, que además **se renueva solo**.

### 4.4 Reverse proxy (Caddy)
Un **reverse proxy** es un "recepcionista" que está adelante de tus apps:

```
Internet ──HTTPS(443)──► Caddy ──reenvía por dentro──► tu app (localhost:3001)
                          │
                     pone el candado 🔒 (HTTPS)
```

Usamos **Caddy**. ¿Por qué no poner la app directo en el 443?
1. **Certificados**: Caddy los saca y renueva solo; la app no sabe (ni necesita).
2. **Una sola app escucha un puerto**: Caddy ocupa el 443 y desde ahí **reparte a
   muchas apps** según el dominio (`gastaker.xyz → 3001`, `otra.xyz → 3002`…).
3. **Simplicidad**: la app habla HTTP simple por dentro; Caddy hace lo difícil.

Nuestro `Caddyfile` es de 3 líneas:
```caddy
gastaker.xyz, www.gastaker.xyz {
    reverse_proxy localhost:3001
}
```

### 4.5 ¿Cómo se "resuelve" el puerto entonces?
Dos puertos, decididos en momentos distintos:
1. **Puerto público (lo elige el navegador)**: `https://` → asume **443**. El DNS le
   dio la IP. Golpea `IP:443`, donde está Caddy.
2. **Puerto interno (lo elige Caddy)**: el pedido **trae el nombre del dominio**;
   Caddy lo lee y reenvía al puerto interno correcto (3001).

Por eso una sola IP puede servir **muchas webs**: todas entran por 443 y Caddy las
separa por nombre. El DNS solo se ocupa de "llegar a la IP".

---

## 5. La integración con Gmail (webhooks)

### 5.1 ¿Qué es un webhook?
Un **webhook** es una **URL que tu app expone para recibir datos** que le manda otro
sistema. En vez de que tu app pregunte "¿hay algo nuevo?", el otro sistema le
**avisa** mandándole un POST. El nuestro es `https://gastaker.xyz/api/ingest`.

### 5.2 El "santo y seña" (`WEBHOOK_SECRET`)
Como esa URL es pública, necesita un candado para que no entre cualquiera a cargar
gastos falsos. Se usa un **secreto compartido**: la misma clave está en el `.env`
de la app **y** en el Apps Script. Quien manda datos debe incluirla en un header
(`X-Webhook-Secret`); si no coincide, la app responde **401** y rechaza.

```
Apps Script (sabe el SECRET) ──POST + header──► App (compara el SECRET)
                                                  coincide → guarda ✅
                                                  no       → 401 ❌
```

### 5.3 El circuito completo (cada 5 minutos)
```
GMAIL → APPS SCRIPT (Google) → /api/ingest (tu app)

1. Santander te manda un mail de consumo.
2. Un trigger de 5 min dispara sync(): busca mails de Santander
   sin la etiqueta "gastaker-procesado".
3. Por cada mail, hace POST a /api/ingest con el contenido,
   + header X-Webhook-Secret.
4. Tu app valida el secreto, parsea (monto/comercio), categoriza
   y guarda en SQLite. Responde 200.
5. Si fue 200, el Apps Script etiqueta el mail como procesado
   (para no mandarlo dos veces).
```

Detalle clave: **Gmail no se puede "hostear"** en ningún lado; leer el correo
**siempre** requiere algo del lado de Google (el **Apps Script**). Esa parte es
igual sin importar dónde corra tu app.

---

## 6. Decisiones de arquitectura: VPS vs. Vercel vs. Railway

No todo se deploya igual. La pregunta clave es **cómo guarda los datos** la app.

- Gastaker usa **SQLite en un archivo en disco**. Eso necesita un **proceso
  prendido** con **disco persistente**.
- **Vercel** es **serverless**: el código nace y muere en cada request y el disco es
  **efímero**. SQLite-en-archivo **no sobrevive** ahí → habría que reescribir la app
  para usar una base hosteada (Postgres/Turso/etc).
- Un **VPS** corre un proceso 24/7 con disco real → **SQLite funciona nativo**. Es
  la opción correcta para esta app (no fue overkill).
- **Railway / Render / Fly.io** = punto medio: contenedor persistente con "volumen"
  (SQLite funciona) + HTTPS y dominio **automáticos**. Menos trabajo manual que el
  VPS, sin reescribir nada.

Resumen: **la forma de guardar datos define la plataforma.** Disco persistente →
VPS o Railway/Render/Fly. Serverless (Vercel) → necesitás base hosteada.

---

## 7. Glosario rápido

| Término | En criollo |
|---------|------------|
| **VPS** | computadora alquilada en la nube, prendida 24/7 |
| **localhost / 127.0.0.1** | la propia máquina; privado |
| **Puerto** | número de "ventanilla" de un programa; uno por programa |
| **Proceso** | el código corriendo (vs. el código quieto en disco) |
| **Env var / `.env`** | configuración y secretos fuera del código |
| **pm2** | mantiene la app prendida y la revive |
| **IP** | dirección numérica de una máquina |
| **DNS** | agenda que traduce nombre → IP |
| **Registro A** | "este nombre apunta a esta IPv4" |
| **Propagación** | el tiempo que tardan los cambios de DNS en verse |
| **Firewall / UFW** | decide qué puertos están abiertos al mundo |
| **SSH (22)** | administración remota del server |
| **HTTP / HTTPS** | web sin cifrar (80) / cifrada (443) |
| **TLS** | el cifrado que usa HTTPS |
| **Certificado** | prueba de que el dominio es tuyo (lo da Let's Encrypt) |
| **Reverse proxy / Caddy** | recepcionista que pone HTTPS y reparte por dominio |
| **Webhook** | URL que recibe datos que otro sistema te empuja |
| **Apps Script** | mini-programa de Google que automatiza Gmail |
| **SQLite** | base de datos guardada en un solo archivo |
| **Serverless** | código que nace/muere por request, sin disco fijo (Vercel) |

---

## 8. Cheatsheet de comandos que usamos

```bash
# --- App / Node ---
npm install                 # instalar dependencias
npm test                    # correr los tests
node --env-file=.env src/server.js   # correr cargando el .env

# --- pm2 (process manager) ---
pm2 start src/server.js --name gastaker --node-args="--env-file=/ruta/.env"
pm2 list                    # ver estado
pm2 logs gastaker           # ver logs
pm2 restart gastaker        # reiniciar (tras cambios)
pm2 save                    # recordar la lista de procesos

# --- Puertos / red ---
ss -ltnp                    # qué procesos escuchan y en qué puertos
curl -I http://127.0.0.1:3001/   # probar la app localmente

# --- DNS ---
dig +short gastaker.xyz A                       # resolver vía cache
dig @1.1.1.1 +short gastaker.xyz A              # vía Cloudflare
dig @dns1.registrar-servers.com gastaker.xyz A  # directo al autoritativo (sin cache)

# --- Firewall (UFW) ---
sudo ufw allow 22/tcp       # abrir SSH (¡ANTES de activar!)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable             # activar
sudo ufw status verbose     # ver reglas

# --- Caddy (reverse proxy + HTTPS) ---
sudo nano /etc/caddy/Caddyfile     # editar config
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy        # aplicar cambios
```

---

## 9. El mapa completo del sistema

```
                         ┌──────────────────────────────────────────────┐
                         │                 TU VPS                        │
   Internet              │                                               │
      │                  │   ┌─────────┐        ┌────────────────────┐   │
 https://gastaker.xyz ───┼──►│  Caddy  │──443──►│ Gastaker (Node)    │   │
      │                  │   │ (HTTPS) │  proxy │ pm2 · localhost:3001│   │
      │                  │   └─────────┘        │   └─► SQLite (.db)  │   │
   (puerto 443)          │        ▲             └────────────────────┘   │
      │                  │        │  reenvía por dominio                 │
      │                  │   ┌─────────┐                                 │
  SSH (22) ──────────────┼──►│  sshd   │  (solo vos, con llave)          │
      │                  │   └─────────┘                                 │
      │                  │   Firewall UFW: solo 22 / 80 / 443 abiertos   │
                         └──────────────────────────────────────────────┘
                                         ▲
                                         │ POST /api/ingest
                                         │ (header X-Webhook-Secret)
                              ┌──────────────────────┐
                              │  Apps Script (Google) │  cada 5 min
                              │  lee Gmail (Santander) │
                              └──────────────────────┘
                                         ▲
                                         │ mails de consumo
                                   ┌───────────┐
                                   │   GMAIL    │
                                   └───────────┘
```

---

### Cierre
Si te quedás con **una sola idea**: publicar una web es **resolver capas** —
correr el código (proceso + puerto), darle un nombre (DNS), exponerlo seguro
(firewall + HTTPS vía reverse proxy) y conectarlo con el mundo (webhooks). Cada
herramienta (pm2, Caddy, UFW, Let's Encrypt) resuelve **una** de esas capas.
