const jwt = require('jsonwebtoken');
const axios = require('axios');
const { getDB } = require('../database');
require('dotenv').config();

const API_URL = 'http://localhost:3000/api/ai-chat/send';
const JWT_SECRET = process.env.JWT_SECRET;

async function test() {
    const db = getDB();
    const user = db.prepare('SELECT * FROM users LIMIT 1').get();

    if (!user) {
        console.error('No user found');
        process.exit(1);
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    console.log(`Using user: ${user.name} (${user.id})`);

    try {
        const res = await axios.post(API_URL, {
            persona: 'sona',
            message: 'Hello, are you there?'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Success:', res.data);
    } catch (err) {
        if (err.response) {
            console.error('API Error:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Network Error:', err.message);
        }
    }
}

test();
