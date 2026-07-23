# Filtro "Solo crédito" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poder filtrar la tabla de Movimientos a solo los consumos con tarjeta de crédito del mes, desde el dropdown de filtros existente.

**Architecture:** Frontend-only: los gastos ya viajan completos en `GET /api/expenses` (con `payment_method`) y el filtro re-renderiza sin refetch. Se agrega una opción con valor centinela `__credito__` al dropdown `#cat-filter` y una rama nueva en el cálculo de `shown` dentro de `render()`.

**Tech Stack:** Vanilla JS (`public/app.js`), sin backend ni dependencias.

**Spec:** `docs/superpowers/specs/2026-07-23-filtro-credito-design.md`

## Global Constraints

- Comentarios en español, mismo tono que el código existente.
- Sin cambios de backend, sin dependencias nuevas.
- Commit estilo conventional en español.
- No hay harness de frontend: la verificación es `node --check` + chequeo manual en navegador; correr `npx vitest run` una vez para confirmar que nada del backend se rompió.
- Etiqueta exacta de la opción: `💳 Solo crédito`. Valor centinela exacto: `__credito__`.

---

### Task 1: Opción "Solo crédito" en el dropdown y filtrado en `render()`

**Files:**
- Modify: `public/app.js` (constante nueva junto a `activeCat` ~línea 25; bloque del dropdown ~líneas 147-151; cálculo de `shown` ~línea 154; comentario de `setFilter` ~líneas 189-190)

**Interfaces:**
- Consumes: `esCredito(e)` (predicado ya definido dentro de `render()`: `e.payment_method === 'Crédito'`), `activeCat` / `setFilter()` / `render()` existentes.
- Produces: nada — task final, nadie depende de esto.

- [ ] **Step 1: Constante centinela**

En `public/app.js`, debajo de la línea `let activeCat = null // categoría seleccionada para filtrar la tabla` (~línea 25), agregar:

```js
const FILTRO_CREDITO = '__credito__' // valor centinela del dropdown: "solo crédito", no es una categoría
```

- [ ] **Step 2: Opción en el dropdown**

En `render()`, reemplazar el bloque del filtro (~líneas 147-151):

```js
  // filtro: dropdown con las categorías presentes este mes (Todas + cada una)
  const present = CATS.map((c) => c.name).filter((name) => expenses.some((e) => e.category === name))
  $('#cat-filter').innerHTML =
    `<option value="">Todas las categorías</option>` +
    present.map((c) => `<option value="${c}"${c === activeCat ? ' selected' : ''}>${c}</option>`).join('')
```

por:

```js
  // filtro: dropdown con "Solo crédito" (si el mes tiene crédito) + las
  // categorías presentes este mes (Todas + cada una)
  const present = CATS.map((c) => c.name).filter((name) => expenses.some((e) => e.category === name))
  const opcionCredito = expenses.some(esCredito)
    ? `<option value="${FILTRO_CREDITO}"${activeCat === FILTRO_CREDITO ? ' selected' : ''}>💳 Solo crédito</option>` +
      `<option disabled>─────────</option>`
    : ''
  $('#cat-filter').innerHTML =
    `<option value="">Todas las categorías</option>` +
    opcionCredito +
    present.map((c) => `<option value="${c}"${c === activeCat ? ' selected' : ''}>${c}</option>`).join('')
```

- [ ] **Step 3: Rama de filtrado**

En `render()`, reemplazar (~línea 154):

```js
  // ledger (filtrado por la categoría activa, si hay)
  const shown = activeCat ? expenses.filter((e) => e.category === activeCat) : expenses
```

por:

```js
  // ledger (filtrado por la categoría activa o "solo crédito", si hay).
  // El centinela se chequea ANTES que los nombres: nunca colisiona con una categoría.
  const shown =
    activeCat === FILTRO_CREDITO
      ? expenses.filter(esCredito)
      : activeCat
        ? expenses.filter((e) => e.category === activeCat)
        : expenses
```

- [ ] **Step 4: Comentario de `setFilter`**

Reemplazar el comentario de `setFilter` (~líneas 189-190):

```js
// Aplica el filtro de categoría del dropdown y re-renderiza (sin refetch).
// cat = '' (Todas) -> null.
```

por:

```js
// Aplica el filtro del dropdown y re-renderiza (sin refetch).
// cat = '' (Todas) -> null; FILTRO_CREDITO -> solo consumos con crédito.
```

(El cuerpo de `setFilter` no cambia: el centinela viaja como cualquier value.)

- [ ] **Step 5: Verificación estática y suite**

Run: `node --check public/app.js`
Expected: sin salida (OK).

Run: `npx vitest run`
Expected: PASS (187/187 — el backend no se tocó).

- [ ] **Step 6: Verificación manual en navegador**

```bash
npm start
```

1. Mes con consumos crédito: el dropdown muestra "💳 Solo crédito" segundo, luego el separador de guiones (no seleccionable), luego las categorías.
2. Elegir "Solo crédito": la tabla muestra solo filas con badge "crédito" (de cualquier categoría) y el contador acompaña.
3. Elegir después una categoría: filtra por esa categoría normalmente (y viceversa).
4. Cambiar de mes: vuelve a "Todas las categorías".
5. Mes sin crédito: ni la opción ni el separador aparecen.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): filtro 'Solo crédito' en el dropdown de movimientos"
```
