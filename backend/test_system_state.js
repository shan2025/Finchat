// test_system_state.js — Quick test for Plato's live system snapshot
const { getDB } = require('./database');
getDB(); // init DB

const { getSystemSnapshot } = require('./services/systemState');

(async () => {
    console.log('Testing Plato system snapshot...\n');
    const snapshot = await getSystemSnapshot();
    console.log(snapshot);
    console.log('\n✅ Snapshot generated successfully!');
    process.exit(0);
})();
