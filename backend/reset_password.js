const sqlite3 = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new sqlite3('finchat.db');
const email = 'druba@gmail.com';
const newPassword = 'password123';

async function resetPassword() {
    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(newPassword, salt);

        const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?');
        const info = stmt.run(hash, email);

        if (info.changes > 0) {
            console.log(`✅ Password for ${email} reset to '${newPassword}'`);
        } else {
            console.log(`❌ User ${email} not found`);
        }
    } catch (err) {
        console.error('Error resetting password:', err);
    }
}

resetPassword();
