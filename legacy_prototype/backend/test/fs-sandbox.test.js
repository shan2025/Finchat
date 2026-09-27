// test/fs-sandbox.test.js — file_read and glob stay inside the app's code.
//
// Any user can address Hopper, and Hopper holds file_read. Before the sandbox,
// "read /proc/self/environ" (or ../.env) returned every production secret.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { ROOTS, resolveReadable, denialReason } = require('../tools/fsSandbox');
const FileReadTool = require('../tools/FileReadTool');
const GlobTool = require('../tools/GlobTool');

const BACKEND = path.resolve(__dirname, '..');

describe('fsSandbox', () => {
  test('the roots are the backend and frontend directories, never a filesystem root', () => {
    assert.deepStrictEqual(ROOTS, [BACKEND, path.resolve(BACKEND, '..', 'frontend')]);
    for (const r of ROOTS) {
      assert.notStrictEqual(path.parse(r).root, r, `${r} must not be a filesystem root`);
    }
  });

  test('ordinary source files are readable', () => {
    assert.ok(resolveReadable(path.join(BACKEND, 'server.js')));
    assert.ok(resolveReadable(path.join(BACKEND, '.env.example')), 'the template is documentation, not a secret');
  });

  test('secrets inside the roots are refused', () => {
    for (const name of ['.env', '.env.production', '.solana-keypair.json', '.vapid-keys.json', 'server.pem', 'finchat.db']) {
      assert.ok(denialReason(path.join(BACKEND, name)), `${name} must be refused`);
    }
    assert.ok(denialReason(path.join(BACKEND, 'uploads', 'x.pdf')), 'user uploads must be refused');
    assert.ok(denialReason(path.join(BACKEND, '.git', 'config')), '.git must be refused');
  });

  test('paths outside the roots are refused, however they are spelled', () => {
    for (const p of [
      path.join(BACKEND, '..', '..', 'README.md'),
      path.join(BACKEND, 'tools', '..', '..', '..', 'render.yaml'),
      path.parse(BACKEND).root,
      '/proc/self/environ',
      '/etc/passwd'
    ]) {
      assert.throws(() => resolveReadable(p), /Access denied/, `${p} must be refused`);
    }
  });
});

describe('the tools enforce it', () => {
  test('file_read returns an error, not the contents, for a secret', async () => {
    const r = await FileReadTool.execute({ file_path: path.join(BACKEND, '.env') });
    assert.ok(r.error && /Access denied|ENOENT/.test(r.error), JSON.stringify(r));
    assert.strictEqual(r.content, undefined);
  });

  test('file_read refuses /proc/self/environ', async () => {
    const r = await FileReadTool.execute('/proc/self/environ');
    assert.match(r.error, /Access denied/);
  });

  test('file_read still reads code', async () => {
    const r = await FileReadTool.execute({ file_path: path.join(BACKEND, 'package.json'), limit: 3 });
    assert.ok(!r.error, r.error);
    assert.match(r.content, /\{/);
  });

  test('glob refuses to walk out with .. or an absolute pattern', async () => {
    assert.match((await GlobTool.execute({ pattern: '../../**' })).error, /Access denied/);
    assert.match((await GlobTool.execute({ pattern: '/etc/*' })).error, /Access denied/);
    assert.match((await GlobTool.execute({ pattern: '*', dir: '/' })).error, /Access denied/);
  });

  test('glob lists code but hides secrets', async () => {
    const r = await GlobTool.execute({ pattern: '{*.js,.env*}', dir: BACKEND });
    assert.ok(!r.error, r.error);
    assert.ok(r.files.includes('server.js'));
    assert.ok(!r.files.some(f => /^\.env$/.test(path.basename(f))), 'a .env file must not be listed');
  });
});
