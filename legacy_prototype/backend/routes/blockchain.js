// routes/blockchain.js — live blockchain status for the Blockchain page (Sprint 8)
//
// FinChat anchors its tamper-evident proof chain to Solana devnet (SPL Memo
// transactions at checkpoint heights). This route exposes:
//   GET /status — which chain is in use, RPC health, wallet, proof-chain stats
//   GET /blocks — recent proof-chain blocks for the animated linear chain view
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOrCreateKeypair, getConnection, SOLANA_RPC } = require('../services/solana');

// Bound every RPC call — devnet can stall for many seconds and the page
// shouldn't wait on it. Timed-out calls just report null/offline.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), ms))
  ]);
}

// ── GET /api/blockchain/status ──
router.get('/status', requireAuth, async (req, res) => {
  try {
    let currentSlot = null, balanceSol = null, walletAddress = null;
    try {
      walletAddress = getOrCreateKeypair().publicKey.toBase58();
    } catch (e) { /* keypair issues shouldn't kill the page */ }

    // Slot + balance in parallel, 3.5s budget each; DB stats run alongside.
    const conn = getConnection();
    const [slotR, balR] = await Promise.allSettled([
      withTimeout(conn.getSlot(), 3500),
      walletAddress ? withTimeout(conn.getBalance(getOrCreateKeypair().publicKey), 3500) : Promise.reject(new Error('no wallet'))
    ]);
    if (slotR.status === 'fulfilled') currentSlot = slotR.value;
    if (balR.status === 'fulfilled') balanceSol = +(balR.value / LAMPORTS_PER_SOL).toFixed(4);
    const reachable = slotR.status === 'fulfilled';

    const stats = await query(`
      SELECT COUNT(*)::int AS total,
             COALESCE(MAX(chain_height), 0)::int AS height,
             COUNT(*) FILTER (WHERE solana_tx IS NOT NULL)::int AS anchored,
             COUNT(*) FILTER (WHERE solana_tx IS NOT NULL AND solana_tx NOT LIKE 'sim_%')::int AS anchored_real
      FROM proof_chain
    `);
    const lastAnchor = await query(`
      SELECT chain_height, solana_tx, solana_slot, timestamp
      FROM proof_chain WHERE solana_tx IS NOT NULL
      ORDER BY chain_height DESC LIMIT 1
    `);

    const s = stats.rows[0] || {};
    res.json({
      chain: {
        name: 'Solana',
        cluster: SOLANA_RPC.includes('devnet') ? 'devnet' : SOLANA_RPC.includes('mainnet') ? 'mainnet-beta' : 'custom',
        rpc: SOLANA_RPC,
        program: 'SPL Memo (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)',
        reachable,
        currentSlot
      },
      wallet: { address: walletAddress, balanceSol },
      proofChain: {
        height: s.height || 0,
        totalProofs: s.total || 0,
        anchored: s.anchored || 0,
        anchoredReal: s.anchored_real || 0,
        checkpointInterval: 10,
        lastAnchor: lastAnchor.rows[0] || null
      }
    });
  } catch (err) {
    console.error('Blockchain status error:', err);
    res.status(500).json({ error: 'Failed to load blockchain status' });
  }
});

// ── GET /api/blockchain/blocks?limit=16 ── newest blocks, oldest→newest ──
router.get('/blocks', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 16, 60);
    const blocks = await query(`
      SELECT proof_id, chain_height, hash, prev_hash, sender_id,
             solana_tx, solana_slot, solana_confirmed, timestamp
      FROM proof_chain
      ORDER BY chain_height DESC
      LIMIT $1
    `, [limit]);
    res.json({ blocks: blocks.rows.reverse() });
  } catch (err) {
    console.error('Blockchain blocks error:', err);
    res.status(500).json({ error: 'Failed to load blocks' });
  }
});

module.exports = router;
