const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

async function fixLogin() {
    const dbPath = path.resolve('e:/FinChat/finchat/backend/finchat.db');
    console.log('Connecting to:', dbPath);
    const db = new Database(dbPath);

    const email = 'admin@finchat.com';
    const password = 'Admin123!';
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

    if (user) {
        console.log('Updating existing admin:', email);
        db.prepare('UPDATE users SET password_hash = ?, is_frozen = 0, role = "admin", token_balance = 10000 WHERE id = ?')
            .run(hashedPassword, user.id);
    } else {
        console.log('Creating new admin:', email);
        const userId = uuidv4();
        db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, token_balance, auth_method)
      VALUES (?, ?, ?, ?, 'admin', 10000, 'password')
    `).run(userId, 'Project Admin', email, hashedPassword);
    }

    console.log('--- DONE ---');
    console.log('You can now log in with:');
    console.log('Email: ' + email);
    console.log('Password: ' + password);
}

fixLogin().catch(err => console.error(err));
