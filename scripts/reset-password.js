// scripts/reset-password.js
// Resetea la password de un usuario (emergencias). No crea usuarios.
//
// Uso:
//   node scripts/reset-password.js <email> <nueva-password>
//   (respeta DB_PATH; por defecto ./gastaker.db)
import { createDb } from '../src/db.js'
import { hashPassword } from '../src/crypto.js'

const [email, newPassword] = process.argv.slice(2)
if (!email || !newPassword) {
  console.error('Uso: node scripts/reset-password.js <email> <nueva-password>')
  process.exit(1)
}

const dbPath = process.env.DB_PATH || './gastaker.db'
const db = createDb(dbPath)
const user = db.getUserByEmail(email)
if (!user) {
  console.error(`❌ No existe ningún usuario con el email ${email}`)
  process.exit(1)
}

db._raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id)
console.log(`✅ Password actualizada para ${email}.`)
