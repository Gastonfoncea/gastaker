# Filtro "Solo crédito" en Movimientos

**Fecha:** 2026-07-23
**Estado:** aprobado (diseño validado en conversación)

## Problema

Los consumos con tarjeta de crédito del mes se ven en la lista (badge
"crédito") y suman en la línea "Tarjeta" del header, pero no hay forma de
filtrar la tabla de Movimientos para ver solo esos consumos — los que entraron
este mes pero se debitan con el resumen el mes que viene. El dropdown de
filtros solo filtra por categoría.

## Qué se quiere

Una opción **"💳 Solo crédito"** en el dropdown de filtros existente
(`#cat-filter`), que filtre la lista a los gastos con
`payment_method === 'Crédito'` del mes, de cualquier categoría.

## Diseño

Frontend-only: los gastos del mes ya viajan completos en `GET /api/expenses`
(incluido `payment_method`) y el filtro actual re-renderiza sin refetch.
"Solo crédito" es un caso más del mismo mecanismo. Cero backend.

Todo en `public/app.js`:

- **Dropdown** (en `render()`): orden de opciones —
  1. `Todas las categorías` (value `""`)
  2. `💳 Solo crédito` (value `__credito__`), solo si el mes tiene al menos un
     gasto con `payment_method === 'Crédito'` (misma regla que las categorías,
     que solo se listan si están presentes en el mes).
  3. Un separador no seleccionable (`<option disabled>` con guiones), solo si
     la opción crédito está visible.
  4. Las categorías presentes en el mes, como hoy.
- **Estado**: se reusa la variable `activeCat` con el valor centinela
  `__credito__`. No puede colisionar con una categoría real: el filtro chequea
  el centinela ANTES de comparar contra nombres de categoría.
- **Filtrado** (en `render()`): si el filtro es el centinela, la lista muestra
  `expenses.filter((e) => e.payment_method === 'Crédito')`; si no, filtra por
  categoría como hoy.
- **Excluyente con categoría**: el dropdown es single-select; elegís "Solo
  crédito" O una categoría.
- **Reset**: cambiar de mes resetea el filtro (comportamiento existente:
  `prev`/`next` ya hacen `activeCat = null`).
- **Contador "N gastos"**: refleja lo filtrado, como ya pasa con categorías.
  Sin cambios de código.

## Verificación (manual, sin harness de frontend)

- Mes con crédito: la opción aparece, filtra a solo consumos crédito (de
  cualquier categoría), el contador acompaña, el separador no es seleccionable.
- Mes sin crédito: ni la opción ni el separador aparecen.
- Elegir una categoría después de "Solo crédito" (y viceversa) cambia el
  filtro limpiamente.
- Cambiar de mes vuelve a "Todas las categorías".
- `node --check public/app.js` pasa.

## Qué NO se hace (YAGNI)

- Sin endpoint ni query param nuevo en el backend.
- Sin filtro "solo débito" ni combinación categoría+crédito.
- La línea "Tarjeta" del header no se vuelve clickeable.
- Sin persistencia del filtro entre sesiones o meses.
