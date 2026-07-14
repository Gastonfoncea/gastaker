# Recategorización con alcance + categorías dinámicas

**Fecha:** 2026-07-14
**Estado:** aprobado

## Problema

Hoy corregir la categoría de un gasto en la web solo afecta ese gasto: el sistema
no aprende, y el mismo comercio vuelve a caer mal categorizado. A la vez, no se
puede propagar a ciegas: un mismo destinatario de transferencia (CUIT) puede ser
"Comida" un día y "Ropa" otro. Además, las categorías están hardcodeadas en el
frontend y no se pueden crear nuevas.

## Solución

Dos features:

1. **Recategorizar con alcance**: al cambiar la categoría de un gasto en la web,
   elegir entre "solo este gasto" o "siempre este comercio". "Siempre" aprende la
   regla en `comercios_conocidos` y re-categoriza TODOS los gastos de ese
   comercio (histórico incluido).
2. **Categorías dinámicas**: tabla `categories` en la DB, con página de gestión
   (crear / renombrar / borrar) accesible desde un menú hamburguesa en el home.

## 1. Recategorizar con alcance

### UI (public/app.js)

Flujo actual: click en la categoría de una fila → popover con categorías → elegir
una → PATCH → reload.

Flujo nuevo: al elegir una categoría **distinta a la actual**, el popover pasa a
un segundo paso en lugar de guardar:

```
┌──────────────────────────────────┐
│  PAYU*AR*UBER → Transporte       │
│                                  │
│  [ Solo este gasto ]             │
│  [ Siempre este comercio ]       │
└──────────────────────────────────┘
```

- **Solo este gasto** → `PATCH /api/expenses/:id { category }`.
- **Siempre este comercio** → `PATCH /api/expenses/:id { category, learn: true }`.
- Escape / click afuera cancela sin cambios (comportamiento actual del popover).
- Elegir la misma categoría actual: cierra sin hacer nada (comportamiento actual).

### Backend

`PATCH /api/expenses/:id` acepta body `{ category, learn?: boolean }`:

- **En ambos casos** (con o sin `learn`): usa `db.clasificarGasto(id, category)`
  en vez de `db.updateCategory` — setea la categoría **y limpia `needs_review`**. Esto
  arregla un bug latente: hoy corregir desde la web deja el gasto como pendiente
  para el agente de WhatsApp.
- **Con `learn: true`**: además llama
  `db.registrarComercio({ match: <merchant completo del gasto>, categoria })`.
  El `match` es el string `merchant` completo del gasto (sin edición en v1; para
  matches más finos está `registrar_comercio` por WhatsApp).
- La respuesta con `learn` incluye `{ ok, actualizados }` (cuántos gastos más se
  re-categorizaron), para feedback futuro en la UI (v1 puede ignorarlo y hacer
  reload).

### Cambio de semántica en `registrarComercio` (src/db.js)

El UPDATE de propagación deja de filtrar por `needs_review = 1`: pisa **todos**
los gastos cuyo merchant contenga el `match` (histórico + pendientes), y les
limpia `needs_review`. El agente de WhatsApp hereda este comportamiento — es
coherente: "registrar comercio" significa "este comercio ES esta categoría,
siempre". El campo devuelto `pendientesActualizados` pasa a llamarse
`actualizados` y refleja el total de filas pisadas.

`updateCategory` queda sin usos en rutas; se elimina de la API de `createDb`
(los tests que lo usen migran a `clasificarGasto`).

## 2. Categorías dinámicas

### Tabla nueva (src/db.js)

```sql
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Seed idempotente (solo si la tabla está vacía) con las 8 actuales y sus colores
de `public/app.js`:

| name | color |
|---|---|
| Comida | #FF6B35 |
| Supermercado | #06B6D4 |
| Transporte | #4F46E5 |
| Servicios | #A855F7 |
| Suscripciones | #EC4899 |
| Salud | #10B981 |
| Transferencias | #F59E0B |
| Otros | #64748B |

`Otros` es **protegida**: no se puede renombrar ni borrar (es `DEFAULT_CATEGORY`
del categorizador y el fallback del delete).

### API nueva (src/routes/categories.js, montada bajo auth igual que expenses)

- `GET /api/categories` → `{ categories: [{ id, name, color, count }] }` donde
  `count` = cantidad de gastos con esa categoría.
- `POST /api/categories { name, color }` → crea. Validación: nombre no vacío
  (trim), único (case-insensitive → 409), color con formato `#RRGGBB`.
- `PATCH /api/categories/:id { name?, color? }` → renombra y/o cambia color.
  Renombrar **cascadea por nombre** en la misma transacción:
  `UPDATE expenses SET category = new WHERE category = old` y
  `UPDATE comercios_conocidos SET category = new WHERE category = old`.
  Rechaza renombrar `Otros` (400) y nombre duplicado (409).
- `DELETE /api/categories/:id` → en una transacción: gastos de esa categoría
  pasan a `Otros`, las filas de `comercios_conocidos` que apuntaban a ella se
  borran, y se borra la categoría. Rechaza borrar `Otros` (400). La respuesta
  incluye cuántos gastos pasaron a `Otros`.

Métodos correspondientes en `createDb`: `listCategories()`, `createCategory()`,
`renameCategory()` (o `updateCategoryDef()`), `deleteCategory()`. Las cascadas
van con `sqlite.transaction()`.

### Frontend

**Home (`public/index.html` + `app.js`):**

- `CATS` hardcodeado se reemplaza por fetch a `GET /api/categories` (se carga
  junto con los gastos; `colorOf` cae a gris para nombres desconocidos, como hoy).
- Menú hamburguesa en el header → desplegable con un ítem: **Categorías** →
  navega a `/categorias.html`.

**Página nueva (`public/categorias.html` + `public/categorias.js`):**

- Página aparte (no SPA con router): reusa `styles.css` y la sesión por cookie.
  Si un fetch da 401 → `location = '/'` para loguear.
- Lista de categorías: swatch de color, nombre, cantidad de gastos.
- Crear: input de nombre + selector de color (paleta preset de ~12 colores).
- Renombrar: edición inline del nombre (y cambio de color).
- Borrar: confirmación que muestra cuántos gastos pasarían a `Otros`.
- `Otros` se muestra sin acciones de editar/borrar.
- Link de vuelta al home.

## Edge conocido y aceptado

Las reglas estáticas de `src/categories.js` (RULES) tienen nombres de categoría
hardcodeados. Si se renombra una categoría, esas reglas seguirían creando gastos
nuevos con el nombre viejo (que el frontend mostraría en gris). La solución de
fondo — migrar RULES a `comercios_conocidos` — queda explícitamente fuera de
alcance de esta iteración.

## Testing

Sobre los patrones existentes de `test/` (node:test + supertest si ya se usa):

- `PATCH /api/expenses/:id` sin `learn`: cambia categoría, limpia `needs_review`,
  NO toca otros gastos del mismo merchant.
- Con `learn: true`: aprende la regla, re-categoriza histórico + pendientes del
  mismo merchant, limpia sus `needs_review`, devuelve `actualizados`.
- `registrarComercio` (unit): pisa históricos ya categorizados.
- CRUD de categorías: crear, duplicado (409), color inválido (400), renombrar
  cascadea a `expenses` y `comercios_conocidos`, borrar mueve gastos a `Otros` y
  borra reglas, `Otros` protegida (400 en rename y delete), counts correctos.
- Auth: las rutas de categorías responden 401 sin sesión.

## Fuera de alcance

- Editar el texto del `match` desde la web (se hace por WhatsApp).
- Migrar las RULES estáticas a la DB.
- Reordenar categorías, íconos, límites de presupuesto por categoría.
