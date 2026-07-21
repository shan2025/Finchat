// services/ipfs.js — IPFS storage via Pinata
// Pins proof logs and files to IPFS for permanent decentralized storage
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const PINATA_API_KEY    = process.env.PINATA_API_KEY;
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_KEY;
const PINATA_GATEWAY    = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

const PINATA_BASE = 'https://api.pinata.cloud';

function isConfigured() {
  return PINATA_API_KEY &&
         PINATA_API_KEY !== 'your_pinata_api_key_here' &&
         PINATA_SECRET_KEY &&
         PINATA_SECRET_KEY !== 'your_pinata_secret_key_here';
}

function pinataHeaders() {
  return {
    pinata_api_key:        PINATA_API_KEY,
    pinata_secret_api_key: PINATA_SECRET_KEY
  };
}

// Pin a JSON object to IPFS (used for proof logs + fraud reports)
async function pinJSON(data, name) {
  if (!isConfigured()) {
    console.warn('⚠  Pinata not configured — skipping IPFS pin for:', name);
    return { cid: null, url: null, simulated: true };
  }

  try {
    const response = await axios.post(
      `${PINATA_BASE}/pinning/pinJSONToIPFS`,
      {
        pinataContent: data,
        pinataMetadata: { name: name || 'finchat-proof' },
        pinataOptions:  { cidVersion: 1 }
      },
      { headers: pinataHeaders(), timeout: 20000 }
    );

    const cid = response.data.IpfsHash;
    const url = `${PINATA_GATEWAY}/${cid}`;
    console.log(`📌 Pinned to IPFS: ${name} → ${cid}`);
    return { cid, url, simulated: false };

  } catch (err) {
    console.error('IPFS pin error:', err.message);
    return { cid: null, url: null, simulated: true, error: err.message };
  }
}

// Pin a file to IPFS (used for file attachments)
async function pinFile(filePath, filename) {
  if (!isConfigured()) {
    console.warn('⚠  Pinata not configured — skipping file pin:', filename);
    return { cid: null, url: null, simulated: true };
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename });
    form.append('pinataMetadata', JSON.stringify({ name: filename }));
    form.append('pinataOptions',  JSON.stringify({ cidVersion: 1 }));

    const response = await axios.post(
      `${PINATA_BASE}/pinning/pinFileToIPFS`,
      form,
      {
        headers: { ...form.getHeaders(), ...pinataHeaders() },
        maxBodyLength: Infinity,
        timeout: 60000
      }
    );

    const cid = response.data.IpfsHash;
    const url = `${PINATA_GATEWAY}/${cid}`;
    console.log(`📌 File pinned to IPFS: ${filename} → ${cid}`);
    return { cid, url, simulated: false };

  } catch (err) {
    console.error('IPFS file pin error:', err.message);
    return { cid: null, url: null, simulated: true, error: err.message };
  }
}

// Build the proof JSON object that gets pinned to IPFS
function buildProofDocument(proof, message, sender, fraudLog) {
  return {
    finchat_proof: '1.0',
    chain_height:  proof.chain_height,
    hash:          proof.hash,
    prev_hash:     proof.prev_hash,
    timestamp:     proof.timestamp,
    sender: {
      id:    sender.id,
      name:  sender.name,
      role:  sender.role,
      wallet: sender.wallet_address || null
    },
    message: {
      id:      message.id,
      type:    message.message_type,
      channel: message.channel_id
    },
    content_hash: proof.content_hash,
    fraud_assessment: fraudLog ? {
      risk:      fraudLog.risk_level,
      reason:    fraudLog.reason,
      indicators: JSON.parse(fraudLog.indicators),
      model:     fraudLog.model_used,
      penalty:   fraudLog.token_penalty
    } : null
  };
}

module.exports = { pinJSON, pinFile, buildProofDocument, isConfigured };
