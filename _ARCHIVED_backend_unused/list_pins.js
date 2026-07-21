const axios = require('axios');
require('dotenv').config();

const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_KEY;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

if (!PINATA_API_KEY || !PINATA_SECRET_KEY) {
    console.error('❌ Pinata keys not found in .env');
    process.exit(1);
}

async function listPins() {
    try {
        console.log('🔄 Fetching pinned files from Pinata...');
        const response = await axios.get('https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=10', {
            headers: {
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_SECRET_KEY
            }
        });

        const rows = response.data.rows;
        if (rows.length === 0) {
            console.log('No files pinned yet.');
            return;
        }

        console.log(`\nFound ${response.data.count} pins. Showing latest ${rows.length}:\n`);

        rows.forEach((pin, index) => {
            const name = pin.metadata.name || '(no name)';
            const cid = pin.ipfs_pin_hash;
            const date = new Date(pin.date_pinned).toLocaleString();
            const size = (pin.size / 1024).toFixed(2) + ' KB';

            console.log(`${index + 1}. [${date}] ${name}`);
            console.log(`   CID:  ${cid}`);
            console.log(`   URL:  ${PINATA_GATEWAY}/${cid}`);
            console.log(`   Size: ${size}`);
            console.log('---------------------------------------------------');
        });

    } catch (error) {
        console.error('❌ Error fetching pins:', error.response ? error.response.data : error.message);
    }
}

listPins();
