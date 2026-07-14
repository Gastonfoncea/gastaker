// scripts/bootstrap-user.js
// Adopta los datos preexistentes (single-user) para el primer usuario admin.
// Se corre UNA vez en el deploy de la versión multi-user. Idempotente.
//
// Uso:
//   node scripts/bootstrap-user.js <email> <password>
//   (respeta DB_PATH; por defecto ./gastaker.db)
import { createDb } from '../src/db.js'

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('Uso: node scripts/bootstrap-user.js <email> <password>')
  process.exit(1)
}

const dbPath = process.env.DB_PATH || './gastaker.db'
const db = createDb(dbPath) // corre la migración estructural si hace falta
const raw = db._raw

// 1) Usuario admin (idempotente: reusa si ya existe).
let user = db.getUserByEmail(email)
if (user) {
  console.log(`ℹ️  El usuario ${email} ya existía (id ${user.id}); lo reuso.`)
} else {
  user = db.createUser({ email, password, isAdmin: true })
  console.log(`✅ Usuario admin creado: ${email} (id ${user.id})`)
}

// 2) Adoptar las filas huérfanas (user_id IS NULL) para este usuario.
const adopt = raw.transaction(() => {
  const exp = raw.prepare('UPDATE expenses SET user_id = ? WHERE user_id IS NULL').run(user.id).changes
  const com = raw.prepare('UPDATE comercios_conocidos SET user_id = ? WHERE user_id IS NULL').run(user.id).changes

  // Categorías huérfanas: si el nombre ya lo tiene el usuario (por el seed), se
  // descarta la huérfana; si es una custom que no está en el seed, se le asigna.
  let catsAsignadas = 0
  let catsDescartadas = 0
  for (const c of raw.prepare('SELECT id, name FROM categories WHERE user_id IS NULL').all()) {
    const yaExiste = raw.prepare('SELECT 1 FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, c.name)
    if (yaExiste) {
      raw.prepare('DELETE FROM categories WHERE id = ?').run(c.id)
      catsDescartadas++
    } else {
      raw.prepare('UPDATE categories SET user_id = ? WHERE id = ?').run(user.id, c.id)
      catsAsignadas++
    }
  }
  return { exp, com, catsAsignadas, catsDescartadas }
})
const r = adopt()

console.log(`📦 Adoptados: ${r.exp} gastos, ${r.com} comercios aprendidos.`)
console.log(`🏷️  Categorías: ${r.catsAsignadas} custom asignadas, ${r.catsDescartadas} huérfanas descartadas (ya seedeadas).`)
console.log('')
console.log('🔑 Token de Ingesta (pegalo en el Apps Script, constante INGEST_TOKEN):')
console.log(`   ${user.ingest_token}`)
