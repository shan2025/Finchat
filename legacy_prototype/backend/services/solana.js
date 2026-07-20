// services/solana.js — Real Solana devnet proof anchoring
// Writes message hashes on-chain using SPL Memo Program transactions
const {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const KEYPAIR_PATH = path.join(__dirname, '..', '.solana-keypair.json');

let _connection = null;
let _payer = null;

// Get or create a persistent connection
function getConnection() {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC, 'confirmed');
  }
  return _connection;
}

// Get or generate a devnet keypair (saved to disk for reuse)
function getOrCreateKeypair() {
  if (_payer) return _payer;

  if (fs.existsSync(KEYPAIR_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
      _payer = Keypair.fromSecretKey(Uint8Array.from(raw));
      console.log(`🔑 Loaded persistent Keypair: ${_payer.publicKey.toBase58()}`);
      return _payer;
    } catch (err) {
      console.error('Failed to load keypair, generating new one:', err.message);
    }
  }

  // Generate a new keypair and save it
  _payer = Keypair.generate();
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(_payer.secretKey)));
  console.log(`🔑 New Solana devnet keypair generated: ${_payer.publicKey.toBase58()}`);
  console.log(`💰 Run: solana airdrop 2 ${_payer.publicKey.toBase58()} --url devnet`);
  return _payer;
}

// Request a devnet airdrop (free SOL for testing)
async function requestAirdrop() {
  try {
    const connection = getConnection();
    const payer = getOrCreateKeypair();
    const balance = await connection.getBalance(payer.publicKey);

    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      console.log('💰 Requesting devnet airdrop (balance low)...');
      const sig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      const newBalance = await connection.getBalance(payer.publicKey);
      console.log(`💰 Airdrop confirmed! Balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      return true;
    }

    console.log(`💰 Solana balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL (sufficient)`);
    return true;
  } catch (err) {
    console.error('💰 Airdrop failed:', err.message);
    return false;
  }
}

// Check if Solana RPC is reachable
async function isReachable() {
  try {
    const connection = getConnection();
    await connection.getSlot();
    return true;
  } catch {
    return false;
  }
}

// Anchor a proof hash to Solana devnet — REAL transaction via Memo Program
async function anchorHash(hash, height) {
  try {
    const reachable = await isReachable();

    if (!reachable) {
      // Simulate for local dev when devnet is unreachable
      const fakeTx = 'sim_' + hash.substring(0, 32);
      console.log(`🔗 Solana simulated (offline): block #${height} → ${fakeTx}`);
      return { tx: fakeTx, slot: height * 100, confirmed: true, simulated: true };
    }

    const connection = getConnection();
    const payer = getOrCreateKeypair();

    // Check balance, airdrop if needed
    const balance = await connection.getBalance(payer.publicKey);
    if (balance < 0.005 * LAMPORTS_PER_SOL) {
      console.log('💰 Low balance, requesting airdrop...');
      try {
        const airdropSig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(airdropSig, 'confirmed');
        console.log('💰 Airdrop received!');
      } catch (airdropErr) {
        console.error('💰 Airdrop failed, simulating tx:', airdropErr.message);
        const fakeTx = 'sim_' + hash.substring(0, 32);
        return { tx: fakeTx, slot: 0, confirmed: true, simulated: true };
      }
    }

    // Build the memo transaction
    const memoData = Buffer.from(`finchat:${height}:${hash}`);
    const memoInstruction = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: memoData
    });

    const transaction = new Transaction().add(memoInstruction);

    // Send and confirm the real transaction
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      { commitment: 'confirmed' }
    );

    const slot = await connection.getSlot();

    console.log(`⚓ Solana REAL tx confirmed! block #${height} → ${signature}`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    return { tx: signature, slot, confirmed: true, simulated: false };

  } catch (err) {
    console.error('Solana anchor error:', err.message);
    // Fallback to simulation on error
    const fakeTx = 'sim_' + hash.substring(0, 32);
    return { tx: fakeTx, slot: 0, confirmed: false, simulated: true };
  }
}

// Initialize on startup — generate keypair and airdrop if needed
async function initSolana() {
  try {
    console.log('🔗 Initializing Solana devnet connection...');
    const payer = getOrCreateKeypair();
    const reachable = await isReachable();

    if (reachable) {
      const connection = getConnection();
      const balance = await connection.getBalance(payer.publicKey);
      const solBalance = (balance / LAMPORTS_PER_SOL).toFixed(4);

      console.log(`✅ Solana Devnet Connected! (${SOLANA_RPC})`);
      console.log(`💰 Wallet Balance: ${solBalance} SOL`);

      if (balance < 0.005 * LAMPORTS_PER_SOL) {
        console.log('⚠️ Balance is low. Attempting auto-airdrop...');
        await requestAirdrop();
      } else {
        console.log('🚀 Solana Service Ready & Funded');
      }
    } else {
      console.log('⚠️  Solana devnet unreachable — will simulate transactions (Offline Mode)');
    }
  } catch (err) {
    console.error('Solana init error:', err.message);
  }
}

module.exports = { anchorHash, isReachable, initSolana, getOrCreateKeypair, getConnection, SOLANA_RPC };
