// test/mind-map-doc-file.test.js — every mind map document can be viewed or
// downloaded, and nothing viewed can run script on our origin.
const { test } = require('node:test');
const assert = require('node:assert');
const { sendDocFile, capabilities } = require('../services/cognitive/mindMapDocFile');

function fakeRes() {
  const headers = {};
  return {
    headers, body: null,
    set(k, v) { headers[k.toLowerCase()] = v; return this; },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    send(b) { this.body = b; return this; }
  };
}

test('a safe type is viewed in place, and ?download makes it an attachment', () => {
  const doc = { filename: 'chart.png', mimetype: 'image/png', data: Buffer.from('PNG') };
  const view = fakeRes();
  sendDocFile(view, doc);
  assert.strictEqual(view.headers['content-type'], 'image/png');
  assert.match(view.headers['content-disposition'], /^inline;/);
  assert.match(view.headers['content-security-policy'], /sandbox/);

  const dl = fakeRes();
  sendDocFile(dl, doc, { download: true });
  assert.strictEqual(dl.headers['content-type'], 'application/octet-stream');
  assert.match(dl.headers['content-disposition'], /^attachment; filename="chart.png"/);
});

test('html and svg are never rendered, even when a view is asked for', () => {
  for (const [filename, mimetype] of [['page.html', 'text/html'], ['logo.svg', 'image/svg+xml']]) {
    const res = fakeRes();
    sendDocFile(res, { filename, mimetype, data: Buffer.from('<script>1</script>') });
    assert.strictEqual(res.headers['content-type'], 'application/octet-stream', filename);
    assert.match(res.headers['content-disposition'], /^attachment;/, filename);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  }
});

test('a PDF views without the sandbox CSP Chrome refuses to render under', () => {
  const res = fakeRes();
  res.set('Content-Security-Policy', "default-src 'self'");
  sendDocFile(res, { filename: 'paper.pdf', mimetype: 'application/pdf', data: Buffer.from('%PDF') });
  assert.strictEqual(res.headers['content-type'], 'application/pdf');
  assert.strictEqual(res.headers['content-security-policy'], undefined);
});

test('a document with no stored original still downloads — as its text', () => {
  const res = fakeRes();
  const ok = sendDocFile(res, { filename: 'scan.docx', mimetype: 'application/msword', data: null,
    extracted: 'the words' }, { download: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(res.body.toString(), 'the words');
  assert.match(res.headers['content-disposition'], /filename="scan.docx.txt"/);
  assert.strictEqual(sendDocFile(fakeRes(), { filename: 'x', data: null, extracted: '' }), false);
});

test('a non-ASCII filename survives in filename*', () => {
  const res = fakeRes();
  sendDocFile(res, { filename: 'résumé "final".pdf', mimetype: 'application/pdf', data: Buffer.from('%PDF') }, { download: true });
  const cd = res.headers['content-disposition'];
  assert.match(cd, /filename="r_sum_ final.pdf"/);
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent('résumé "final".pdf')}`));
});

test('capabilities tell the client what View means for each document', () => {
  assert.strictEqual(capabilities({ has_data: true, mimetype: 'image/png', char_count: 0 }).preview, 'image');
  assert.strictEqual(capabilities({ has_data: true, mimetype: 'application/pdf', char_count: 9 }).preview, 'pdf');
  assert.strictEqual(capabilities({ has_data: true, mimetype: 'text/html', char_count: 9 }).preview, 'text');
  assert.strictEqual(capabilities({ has_data: false, mimetype: 'application/pdf', char_count: 9 }).preview, 'text');
  const opaque = capabilities({ has_data: true, mimetype: 'application/zip', char_count: 0 });
  assert.deepStrictEqual([opaque.preview, opaque.downloadable], [null, true]);
  assert.strictEqual(capabilities({ has_data: false, mimetype: '', char_count: 0 }).downloadable, false);
});
