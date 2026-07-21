const axios = require('axios');

async function testRegister() {
    try {
        const res = await axios.post('http://localhost:3000/api/auth/register', {
            name: "Debug User",
            email: "debug@test.com",
            password: "Password123!",
            role: "staff"
        });
        console.log("Success:", res.data);
    } catch (err) {
        console.log("Error Status:", err.response?.status);
        console.log("Error Data:", err.response?.data);
    }
}

testRegister();
