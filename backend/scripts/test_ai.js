const { chatWithPersona } = require('../services/aiChat');

async function test() {
    console.log('Testing chatWithPersona with UNREACHABLE URL...');
    // Mock process.env not working here, so we rely on the default or modification
    // actually aiChat.js reads process.env at top level.
    // We can't easily change the URL constant once required.

    // Instead, let's try to call it. consistently.
    try {
        const res = await chatWithPersona('sona', 'Hello?');
        console.log('Result:', JSON.stringify(res, null, 2));
    } catch (err) {
        console.error('Caught error:', err);
    }
}

test();
