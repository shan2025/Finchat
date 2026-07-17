// Verifies the Neural Map "network" maths in nn_core.js — the same file the
// browser loads. Asserts the model genuinely learns rather than merely running.
const NN = require('../../frontend/nn_core.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };
const train = (net, rows, n) => { let l = 0; for (let i = 0; i < n; i++) l = NN.trainEpoch(net, rows); return l; };

console.log('\n=== Architecture ===');
{
  ok(JSON.stringify(NN.layerSizes({ hidden: 0, width: 6 })) === '[1,1]', 'perceptron is 1 → 1 (no hidden layer)');
  ok(JSON.stringify(NN.layerSizes(NN.normalizeConfig({ hidden: 1, width: 6 }))) === '[1,6,1]', 'MLP is 1 → 6 → 1');
  ok(JSON.stringify(NN.layerSizes(NN.normalizeConfig({ hidden: 2, width: 8 }))) === '[1,8,8,1]', 'deep MLP is 1 → 8 → 8 → 1');
  // 1→6→1 : (1*6+6) + (6*1+1) = 12 + 7 = 19
  ok(NN.paramCount(NN.normalizeConfig({ hidden: 1, width: 6 })) === 19, 'parameter count of 1→6→1 is 19 (weights + biases)');
  const net = NN.createNet({ hidden: 1, width: 6 });
  ok(net.W.length === 2 && net.W[0].length === 6 && net.W[1][0].length === 6, 'weight matrices have the right shape');
  ok(NN.forward(net, 0.5).length === 3, 'forward pass returns one activation vector per layer');
}

console.log('\n=== Config is clamped, never trusted raw ===');
{
  const c = NN.normalizeConfig({ hidden: 99, width: 999, lr: 50, noise: -3, samples: 5000, target: 'nonsense', activation: 'bogus' });
  ok(c.hidden === 3, `hidden clamped to 3 (got ${c.hidden})`);
  ok(c.width === 12, `width clamped to 12 (got ${c.width})`);
  ok(c.lr === 0.6, `lr clamped to 0.6 (got ${c.lr})`);
  ok(c.noise === 0, `negative noise clamped to 0 (got ${c.noise})`);
  ok(c.samples === 80, `samples clamped to 80 (got ${c.samples})`);
  ok(c.target === 'sine', 'unknown target falls back to sine');
  ok(c.activation === 'tanh', 'unknown activation falls back to tanh');
}

console.log('\n=== Determinism ===');
{
  const a = NN.createNet({ seed: 7 }), b = NN.createNet({ seed: 7 }), c = NN.createNet({ seed: 8 });
  ok(JSON.stringify(a.W) === JSON.stringify(b.W), 'same seed → identical initial weights');
  ok(JSON.stringify(a.W) !== JSON.stringify(c.W), 'different seed → different initial weights');
  const d1 = NN.buildData({ seed: 7 }), d2 = NN.buildData({ seed: 7 });
  ok(JSON.stringify(d1.train) === JSON.stringify(d2.train), 'same seed → identical dataset');
  ok(d1.train.length === 30 && d1.test.length === 40, 'train/test split sized as configured');
  const overlap = d1.train.filter(t => d1.test.some(v => v.x === t.x)).length;
  ok(overlap === 0, 'test points are not train points — test error is real generalisation');
}

console.log('\n=== It actually learns ===');
{
  const cfg = { hidden: 1, width: 8, lr: 0.4, noise: 0, samples: 40, target: 'sine', seed: 3 };
  const net = NN.createNet(cfg);
  const { train: rows } = NN.buildData(cfg);
  const before = NN.evaluate(net, rows);
  train(net, rows, 4000);
  const mid = NN.evaluate(net, rows);
  // Full-batch GD at this learning rate oscillates on the way down, so error is
  // not monotonic epoch-to-epoch. Convergence is asserted at a settled point.
  train(net, rows, 16000);
  const after = NN.evaluate(net, rows);
  console.log(`     MSE ${before.mse.toFixed(4)} → ${mid.mse.toFixed(4)} (4k) → ${after.mse.toFixed(5)} (20k) | R² ${before.r2.toFixed(3)} → ${after.r2.toFixed(4)}`);
  ok(mid.mse < before.mse, 'training reduces train MSE');
  ok(after.mse < 0.005, `converges to a low error (${after.mse.toFixed(5)})`);
  ok(after.r2 > 0.99, `R² becomes strong (${after.r2.toFixed(4)})`);
  ok(net.epoch === 20000, 'epoch counter tracks real epochs');

  const truthM = NN.evaluateAgainstTruth(net);
  ok(truthM.r2 > 0.95, `recovers the underlying function, not just the samples (R²=${truthM.r2.toFixed(4)})`);
}

console.log('\n=== A perceptron cannot fit a sine (capacity is real) ===');
{
  const cfg = { hidden: 0, lr: 0.4, noise: 0, samples: 40, target: 'sine', seed: 3 };
  const net = NN.createNet(cfg);
  const { train: rows } = NN.buildData(cfg);
  train(net, rows, 4000);
  const m = NN.evaluate(net, rows);
  console.log(`     perceptron MSE ${m.mse.toFixed(4)}, R² ${m.r2.toFixed(3)}`);
  ok(m.mse > 0.05, 'a linear model leaves large error on a non-linear target');
  ok(NN.diagnose(m, m).verdict.includes('Underfitting'), 'and is correctly diagnosed as underfitting');
}

console.log('\n=== Every activation trains ===');
{
  for (const act of ['tanh', 'relu', 'sigmoid']) {
    const cfg = { hidden: 1, width: 10, lr: 0.3, noise: 0, samples: 40, target: 'sine', seed: 5, activation: act };
    const net = NN.createNet(cfg);
    const { train: rows } = NN.buildData(cfg);
    const b = NN.evaluate(net, rows).mse;
    train(net, rows, 3000);
    const a = NN.evaluate(net, rows).mse;
    ok(a < b * 0.5, `${act}: MSE ${b.toFixed(4)} → ${a.toFixed(4)}`);
  }
}

console.log('\n=== Metrics are mathematically correct ===');
{
  // A hand-checkable case: force predictions by stubbing the net.
  const stub = { cfg: NN.normalizeConfig({}), W: [], b: [] };
  const fake = { ...stub };
  const rows = [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }];
  // Monkey-patch predict via a net whose forward returns a constant 2.
  const constNet = NN.createNet({ hidden: 0, seed: 1 });
  constNet.W[0][0][0] = 0; constNet.b[0][0] = 2;   // output = 2 regardless of x
  const m = NN.evaluate(constNet, rows);
  // errors: -1, 0, +1 → MSE = 2/3, RMSE = .8165, MAE = 2/3, maxError = 1
  ok(Math.abs(m.mse - 2 / 3) < 1e-9, `MSE = 2/3 (got ${m.mse})`);
  ok(Math.abs(m.rmse - Math.sqrt(2 / 3)) < 1e-9, `RMSE = sqrt(MSE) (got ${m.rmse})`);
  ok(Math.abs(m.mae - 2 / 3) < 1e-9, `MAE = 2/3 (got ${m.mae})`);
  ok(Math.abs(m.maxError - 1) < 1e-9, `max error = 1 (got ${m.maxError})`);
  // mean(y)=2, SS_tot = 1+0+1 = 2, SS_res = 2 → R² = 1 - 2/2 = 0
  ok(Math.abs(m.r2 - 0) < 1e-9, `R² = 0 when predicting the mean (got ${m.r2})`);
  ok(m.n === 3, 'n reports the sample count');

  // A perfect model → R² = 1, zero error.
  const perfect = NN.createNet({ hidden: 0, seed: 1 });
  perfect.W[0][0][0] = 1; perfect.b[0][0] = 0;      // output = x
  const idRows = [{ x: -1, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 1 }];
  const pm = NN.evaluate(perfect, idRows);
  ok(pm.mse === 0 && pm.r2 === 1, 'a perfect fit gives MSE 0 and R² 1');

  // Worse than the mean → negative R².
  const bad = NN.createNet({ hidden: 0, seed: 1 });
  bad.W[0][0][0] = 0; bad.b[0][0] = 100;
  ok(NN.evaluate(bad, rows).r2 < 0, 'R² goes negative for a model worse than the mean');
  ok(NN.evaluate(bad, []).n === 0, 'evaluating an empty set does not throw');
}

console.log('\n=== Diagnosis ===');
{
  const good = NN.diagnose({ mse: 0.001 }, { mse: 0.002 });
  ok(good.verdict.includes('Good fit') && good.tone === 'good', 'low train + low gap → good fit');
  const over = NN.diagnose({ mse: 0.001 }, { mse: 0.09 });
  ok(over.verdict.includes('Overfitting') && over.tone === 'bad', 'low train + big gap → overfitting');
  const under = NN.diagnose({ mse: 0.2 }, { mse: 0.21 });
  ok(under.verdict.includes('Underfitting') && under.tone === 'warn', 'high train error → underfitting');
  ok(Math.abs(over.gap - 0.089) < 1e-9, 'generalisation gap = test − train');
  ok(NN.diagnose({ mse: 0.001 }, { mse: 0.0005 }).gap === 0, 'gap never goes negative');
}

console.log('\n=== Save / restore a trained network ===');
{
  const cfg = { hidden: 1, width: 6, lr: 0.3, noise: 0, samples: 30, target: 'bump', seed: 11 };
  const net = NN.createNet(cfg);
  const { train: rows } = NN.buildData(cfg);
  train(net, rows, 1500);
  const trained = NN.evaluate(net, rows).mse;

  const restored = NN.hydrate(cfg, JSON.parse(JSON.stringify(NN.serialize(net))));
  ok(Math.abs(NN.evaluate(restored, rows).mse - trained) < 1e-12, 'restored network predicts identically');
  ok(restored.epoch === net.epoch, 'restored network keeps its epoch count');

  // Changing the architecture must discard incompatible weights, not crash.
  const reshaped = NN.hydrate({ ...cfg, width: 10 }, NN.serialize(net));
  ok(reshaped.W[0].length === 10, 'changing width rebuilds the network');
  ok(reshaped.epoch === 0, 'and resets the epoch count rather than reusing stale weights');
  ok(NN.hydrate(cfg, null).epoch === 0, 'hydrating with no saved weights starts fresh');
  ok(NN.hydrate(cfg, { W: 'junk' }).epoch === 0, 'hydrating with malformed weights starts fresh');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
