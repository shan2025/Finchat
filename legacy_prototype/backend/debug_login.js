
const axios = require('axios');

async function testLogin() {
    try {
        console.log('Attempting login for druba@gmail.com...');
        const res = await axios.post('http://localhost:3000/api/auth/login', {
            email: 'druba@gmail.com',
            password: '12345678'
        });
        console.log('Login successful:', res.data.user.email);
    } catch (err) {
        if (err.response) {
            console.error('Login failed:', err.response.status, err.response.data);
        } else {
            console.error('Login error:', err.message);
        }
    }
}

testLogin();
