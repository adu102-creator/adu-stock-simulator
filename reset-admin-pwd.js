require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function reset() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const newPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const newHash = bcrypt.hashSync(newPassword, 10);
    const res = await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [newHash, adminUsername]);
    console.log(`Admin password for user "${adminUsername}" updated successfully to "${newPassword}". Rows updated:`, res.rowCount);
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
reset();
