
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

async function testConnection() {
    console.log(`Testing connection to ${OLLAMA_URL} with model ${OLLAMA_MODEL}...`);
    try {
        const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false
        });
        console.log('Success! Response:', response.data.message.content);
    } catch (error) {
        console.error('Failed:', error.message);
        if (error.response) {
            console.error('Data:', error.response.data);
            console.error('Status:', error.response.status);
        }
    }
}

testConnection();
