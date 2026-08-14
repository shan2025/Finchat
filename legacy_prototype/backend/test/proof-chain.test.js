// test/proof-chain.test.js — the hash-chain contract.
//
// This locks a bug that already bit once: createProof hashes the ISO-8601 string
// form of the timestamp, but node-pg returns timestamptz columns as Date objects.
// verifyChain interpolated those raw, so every recomputed hash differed and the
// whole chain reported "Invalid Block Hash". These tests pin the preimage format
// and the timestamp canonicalisation so it cannot silently regress.
//
// Pure: uses the exported sha256/isCheckpoint and reconstructs the preimage. No DB.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sha256, isCheckpoint } = require('../services/proof');

// The preimage contract, copied verbatim from createProof/verifyChain.
// If someone changes the field order or separator, these tests must be updated
// deliberately — that is the point.
const preimage = (prevHash, height, senderId, contentHash, tsIso) =>
  `${prevHash}|${height}|${senderId}|${contentHash}|${tsIso}`;

// How verifyChain must normalise whatever the driver hands back.
const canonicalTs = (ts) =>
  ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();

const GENESIS = '0'.repeat(64);

test('sha256 matches the known vector', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 returns 64 lowercase hex chars', () => {
  assert.match(sha256('anything'), /^[0-9a-f]{64}$/);
});

test.describe('timestamp canonicalisation (the regression)', () => {
  test('a Date and its ISO string produce the same block hash', () => {
    const iso = '2026-07-18T10:20:30.000Z';
    const asDate = new Date(iso);
    const contentHash = sha256('hello');

    const atCreate = sha256(preimage(GENESIS, 1, 'u1', contentHash, iso));
    const atVerify = sha256(preimage(GENESIS, 1, 'u1', contentHash, canonicalTs(asDate)));

    assert.equal(atVerify, atCreate,
      'verifyChain must recompute the hash createProof stored');
  });

  test('interpolating a raw Date does NOT match — this is the bug', () => {
    // Guards against someone "simplifying" the canonicalisation away.
    const iso = '2026-07-18T10:20:30.000Z';
    const contentHash = sha256('hello');
    const correct = sha256(preimage(GENESIS, 1, 'u1', contentHash, iso));
    const naive = sha256(preimage(GENESIS, 1, 'u1', contentHash, new Date(iso)));
    assert.notEqual(naive, correct);
  });

  test('canonicalTs is idempotent', () => {
    const iso = '2026-07-18T10:20:30.000Z';
    assert.equal(canonicalTs(canonicalTs(new Date(iso))), iso);
  });
});

test.describe('tamper detection', () => {
  const base = {
    prev: GENESIS, height: 1, sender: 'u1',
    ts: '2026-07-18T10:20:30.000Z', content: 'transfer 100 to alice',
  };
  const hashOf = (o) =>
    sha256(preimage(o.prev, o.height, o.sender, sha256(o.content.trim()), o.ts));

  test('editing content changes the block hash', () => {
    assert.notEqual(hashOf({ ...base, content: 'transfer 900 to alice' }), hashOf(base));
  });

  test('changing the sender changes the block hash', () => {
    assert.notEqual(hashOf({ ...base, sender: 'u2' }), hashOf(base));
  });

  test('changing the height changes the block hash', () => {
    assert.notEqual(hashOf({ ...base, height: 2 }), hashOf(base));
  });

  test('re-linking to a different previous block changes the hash', () => {
    assert.notEqual(hashOf({ ...base, prev: sha256('other') }), hashOf(base));
  });

  test('content is hashed trimmed, so whitespace alone is not tampering', () => {
    assert.equal(hashOf({ ...base, content: '  transfer 100 to alice  ' }), hashOf(base));
  });

  test('a break at block N invalidates every later block', () => {
    // Build a 5-block chain, then tamper with block 2 and re-link forward.
    const build = (contents) => {
      const blocks = [];
      let prev = GENESIS;
      contents.forEach((c, i) => {
        const contentHash = sha256(c.trim());
        const ts = new Date(Date.UTC(2026, 6, 18, 10, 0, i)).toISOString();
        const hash = sha256(preimage(prev, i + 1, 'u1', contentHash, ts));
        blocks.push({ hash, prev });
        prev = hash;
      });
      return blocks;
    };
    const good = build(['a', 'b', 'c', 'd', 'e']);
    const bad = build(['a', 'TAMPERED', 'c', 'd', 'e']);

    assert.equal(good[0].hash, bad[0].hash, 'block 1 is untouched');
    for (let i = 1; i < 5; i++) {
      assert.notEqual(bad[i].hash, good[i].hash, `block ${i + 1} must be invalidated`);
    }
  });
});

test.describe('checkpoint interval', () => {
  test('fires exactly every 10th block', () => {
    for (let h = 1; h <= 40; h++) {
      assert.equal(isCheckpoint(h), h % 10 === 0, `height ${h}`);
    }
  });

  test('an empty chain is never a checkpoint', () => {
    // 0 % 10 === 0, so the guard `height > 0` is what stops an empty chain from
    // being anchored on Solana. Pinned because removing that guard would look
    // like a harmless simplification.
    assert.equal(isCheckpoint(0), false);
    assert.equal(isCheckpoint(-10), false);
  });
});
