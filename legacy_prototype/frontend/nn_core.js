// nn_core.js — the actual neural-network maths for Neural Map "network" maps.
//
// This file is loaded by the browser (as window.NNCore) AND require()d by
// scripts/test_neural_network.js. One implementation, so the metrics shown in
// the UI are the same numbers the test suite asserts on.
//
// The network is a plain feed-forward MLP: tanh (or relu/sigmoid) hidden units,
// linear output, full-batch gradient descent on mean squared error. Small, but
// genuinely trained — no faked curves.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NNCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── deterministic RNG ────────────────────────────────────
  // Seeded so a given map re-initialises identically and tests are repeatable.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── target functions the network learns to fit ───────────
  const TARGETS = {
    sine:   x => Math.sin(x * Math.PI * 1.5) * 0.8,
    zigzag: x => 0.8 * Math.asin(Math.sin(x * Math.PI * 2)) / (Math.PI / 2),
    step:   x => 0.7 * Math.tanh(Math.sin(x * Math.PI * 1.5) * 8),
    bump:   x => 0.9 * Math.exp(-x * x * 6) - 0.35
  };
  const truth = (target, x) => (TARGETS[target] || TARGETS.sine)(x);

  // ── activations ──────────────────────────────────────────
  const ACTIVATIONS = {
    tanh:    { f: s => Math.tanh(s),                 d: a => 1 - a * a },
    relu:    { f: s => (s > 0 ? s : 0),              d: a => (a > 0 ? 1 : 0) },
    sigmoid: { f: s => 1 / (1 + Math.exp(-s)),       d: a => a * (1 - a) }
  };

  const DEFAULTS = {
    hidden: 1, width: 6, lr: 0.15, noise: 0.12, samples: 30,
    target: 'sine', activation: 'tanh', seed: 42
  };

  function normalizeConfig(cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    c.hidden = Math.max(0, Math.min(3, Math.round(c.hidden)));
    c.width = Math.max(1, Math.min(12, Math.round(c.width)));
    c.lr = Math.max(0.005, Math.min(0.6, Number(c.lr) || DEFAULTS.lr));
    c.noise = Math.max(0, Math.min(0.4, Number(c.noise) || 0));
    c.samples = Math.max(6, Math.min(80, Math.round(c.samples)));
    if (!TARGETS[c.target]) c.target = 'sine';
    if (!ACTIVATIONS[c.activation]) c.activation = 'tanh';
    c.seed = Number.isFinite(c.seed) ? c.seed : DEFAULTS.seed;
    return c;
  }

  const layerSizes = cfg => {
    const L = [1];
    for (let i = 0; i < cfg.hidden; i++) L.push(cfg.width);
    L.push(1);
    return L;
  };

  const paramCount = cfg =>
    layerSizes(cfg).slice(0, -1).reduce((sum, n, i) => {
      const next = layerSizes(cfg)[i + 1];
      return sum + n * next + next;   // weights + biases
    }, 0);

  // ── model ────────────────────────────────────────────────
  function createNet(cfg) {
    const c = normalizeConfig(cfg);
    const L = layerSizes(c);
    const rnd = mulberry32(c.seed);
    const W = [], b = [];
    for (let l = 0; l < L.length - 1; l++) {
      const rows = L[l + 1], cols = L[l], m = [];
      for (let i = 0; i < rows; i++) {
        const r = [];
        // He/Xavier-ish scaling keeps early activations in range.
        for (let j = 0; j < cols; j++) r.push((rnd() * 2 - 1) * (1.2 / Math.sqrt(cols)));
        m.push(r);
      }
      W.push(m);
      b.push(new Array(rows).fill(0));
    }
    return { cfg: c, L, W, b, epoch: 0, history: [] };
  }

  // Full activation stack — the UI needs every layer, not just the output.
  function forward(net, x) {
    const act = ACTIVATIONS[net.cfg.activation];
    const a = [[x]];
    for (let l = 0; l < net.W.length; l++) {
      const prev = a[l], out = [];
      const isLast = l === net.W.length - 1;
      for (let i = 0; i < net.W[l].length; i++) {
        let s = net.b[l][i];
        for (let j = 0; j < prev.length; j++) s += net.W[l][i][j] * prev[j];
        out.push(isLast ? s : act.f(s));   // linear output head
      }
      a.push(out);
    }
    return a;
  }
  const predict = (net, x) => { const a = forward(net, x); return a[a.length - 1][0]; };

  // ── data ─────────────────────────────────────────────────
  // Train and test draw from the same function but different points, so test
  // error measures genuine generalisation rather than memorisation.
  function buildData(cfg) {
    const c = normalizeConfig(cfg);
    const rnd = mulberry32(c.seed + 977);
    const train = [];
    for (let i = 0; i < c.samples; i++) {
      const x = -1 + 2 * (i + rnd() * 0.4) / c.samples;
      train.push({ x, y: truth(c.target, x) + (rnd() * 2 - 1) * c.noise });
    }
    const test = [];
    for (let i = 0; i < 40; i++) {
      const x = -1 + 2 * (rnd());
      test.push({ x, y: truth(c.target, x) + (rnd() * 2 - 1) * c.noise });
    }
    return { train, test };
  }

  // ── training: one full-batch gradient-descent epoch ───────
  function trainEpoch(net, data) {
    const act = ACTIVATIONS[net.cfg.activation];
    const lr = net.cfg.lr, S = data, nL = net.W.length;
    const gW = net.W.map(m => m.map(r => r.map(() => 0)));
    const gb = net.b.map(v => v.map(() => 0));
    let loss = 0;

    for (const s of S) {
      const a = forward(net, s.x);
      const err = a[a.length - 1][0] - s.y;
      loss += err * err;
      let delta = [err];                       // dL/dz at the linear output
      for (let l = nL - 1; l >= 0; l--) {
        const prev = a[l];
        for (let i = 0; i < net.W[l].length; i++) {
          gb[l][i] += delta[i];
          for (let j = 0; j < prev.length; j++) gW[l][i][j] += delta[i] * prev[j];
        }
        if (l > 0) {
          const nd = new Array(prev.length).fill(0);
          for (let j = 0; j < prev.length; j++) {
            let s2 = 0;
            for (let i = 0; i < net.W[l].length; i++) s2 += net.W[l][i][j] * delta[i];
            nd[j] = s2 * act.d(prev[j]);       // chain rule through the activation
          }
          delta = nd;
        }
      }
    }

    const n = S.length || 1;
    for (let l = 0; l < nL; l++) {
      for (let i = 0; i < net.W[l].length; i++) {
        net.b[l][i] -= lr * gb[l][i] / n;
        for (let j = 0; j < net.W[l][i].length; j++) net.W[l][i][j] -= lr * gW[l][i][j] / n;
      }
    }
    net.epoch++;
    return loss / n;
  }

  // ── evaluation ───────────────────────────────────────────
  // Every metric below is computed from real predictions on real held-out data.
  function evaluate(net, rows) {
    if (!rows || !rows.length) return { mse: 0, rmse: 0, mae: 0, r2: 0, maxError: 0, n: 0 };
    let se = 0, ae = 0, maxError = 0, sum = 0;
    const preds = [];
    for (const s of rows) {
      const p = predict(net, s.x);
      preds.push(p);
      const e = p - s.y;
      se += e * e; ae += Math.abs(e);
      if (Math.abs(e) > maxError) maxError = Math.abs(e);
      sum += s.y;
    }
    const n = rows.length;
    const mean = sum / n;
    // R² = 1 − SS_res/SS_tot. Negative means worse than predicting the mean.
    let ssTot = 0;
    for (const s of rows) ssTot += (s.y - mean) * (s.y - mean);
    const r2 = ssTot > 1e-12 ? 1 - se / ssTot : 0;
    return { mse: se / n, rmse: Math.sqrt(se / n), mae: ae / n, r2, maxError, n };
  }

  // How well it recovers the *underlying function*, ignoring sample noise —
  // the cleanest read on whether the model learned the signal.
  function evaluateAgainstTruth(net, grid) {
    const G = grid || 60;
    const rows = [];
    for (let k = 0; k <= G; k++) {
      const x = -1 + 2 * k / G;
      rows.push({ x, y: truth(net.cfg.target, x) });
    }
    return evaluate(net, rows);
  }

  // Bias/variance are proxies: train error stands in for bias, and the
  // train→test gap for variance. Labelled as proxies in the UI too.
  function diagnose(trainM, testM) {
    const bias = Math.min(1, trainM.mse / 0.25);
    const gap = Math.max(0, testM.mse - trainM.mse);
    const variance = Math.min(1, gap / 0.15);
    let verdict, tone;
    if (trainM.mse > 0.05) { verdict = 'Underfitting — high bias'; tone = 'warn'; }
    else if (gap > 0.04 || testM.mse > 0.05) { verdict = 'Overfitting — high variance'; tone = 'bad'; }
    else { verdict = 'Good fit — balanced'; tone = 'good'; }
    return { bias, variance, gap, verdict, tone };
  }

  const serialize = net => ({ W: net.W, b: net.b, epoch: net.epoch, history: net.history.slice(-200) });
  function hydrate(cfg, weights) {
    const net = createNet(cfg);
    if (weights && Array.isArray(weights.W) && Array.isArray(weights.b)) {
      // Only adopt saved weights whose shape still matches the architecture —
      // otherwise the user changed the layout and we must start fresh.
      const shapeOk = weights.W.length === net.W.length &&
        weights.W.every((m, l) => m.length === net.W[l].length &&
          m.every((r, i) => r.length === net.W[l][i].length));
      if (shapeOk) {
        net.W = weights.W; net.b = weights.b;
        net.epoch = weights.epoch || 0;
        net.history = Array.isArray(weights.history) ? weights.history : [];
      }
    }
    return net;
  }

  return {
    DEFAULTS, TARGETS, ACTIVATIONS, mulberry32, truth, normalizeConfig,
    layerSizes, paramCount, createNet, forward, predict, buildData,
    trainEpoch, evaluate, evaluateAgainstTruth, diagnose, serialize, hydrate
  };
}));
