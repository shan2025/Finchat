// test/link-info.test.js — a pasted link is classified from its URL alone.
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, defaultTitle, extractUrls } = require('../services/linkInfo');

test('Google Docs, Sheets and Slides are recognised with a preview URL', () => {
  const d = classify('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit?usp=sharing');
  assert.strictEqual(d.provider, 'gdoc');
  assert.strictEqual(d.label, 'Google Doc');
  assert.strictEqual(d.fileId, '1AbCdEfGhIjKlMnOpQrStUv');
  assert.strictEqual(d.embedUrl, 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/preview');
  assert.strictEqual(classify('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit#gid=0').label, 'Google Sheet');
  assert.strictEqual(classify('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUv/').label, 'Google Slides');
});

test('Drive files, folders and open?id= links', () => {
  const f = classify('https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJi/view?usp=drive_link');
  assert.deepStrictEqual([f.provider, f.fileId, f.embedUrl],
    ['gdrive', '1ZyXwVuTsRqPoNmLkJi', 'https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJi/preview']);
  const folder = classify('https://drive.google.com/drive/folders/1ZyXwVuTsRqPoNmLkJi');
  assert.deepStrictEqual([folder.label, folder.embedUrl], ['Drive folder', null]);
  assert.strictEqual(classify('https://drive.google.com/open?id=1ZyXwVuTsRqPoNmLkJi').fileId, '1ZyXwVuTsRqPoNmLkJi');
});

test('every YouTube URL shape embeds through the no-cookie domain', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ']) {
    const y = classify(url);
    assert.strictEqual(y.provider, 'youtube', url);
    assert.strictEqual(y.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', url);
  }
});

test('images and videos by extension; everything else is a web link', () => {
  assert.strictEqual(classify('https://example.com/a/diagram.PNG?x=1').provider, 'image');
  assert.strictEqual(classify('https://cdn.example.com/demo.mp4').provider, 'video');
  const w = classify('https://www.duxbe.com/pricing');
  assert.deepStrictEqual([w.provider, w.host], ['web', 'duxbe.com']);
});

test('non-http schemes and credentialed URLs are refused', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
    'ftp://example.com/x', 'https://user:pass@example.com/', 'not a url', '']) {
    assert.strictEqual(classify(bad), null, bad);
  }
});

test('a default title is readable, never an opaque id', () => {
  assert.strictEqual(defaultTitle(classify('https://example.com/files/Q3%20plan.pdf')), 'Q3 plan.pdf');
  assert.strictEqual(defaultTitle(classify('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit')), 'Google Doc');
  assert.strictEqual(defaultTitle(classify('https://duxbe.com/')), 'duxbe.com');
  assert.strictEqual(defaultTitle(classify('https://en.wikipedia.org/wiki/Shor%27s_algorithm')),
    "Shor's algorithm — en.wikipedia.org");
  assert.strictEqual(defaultTitle(classify('https://duxbe.com/pricing')), 'duxbe.com/pricing');
});

test('URLs are pulled out of pasted prose without trailing punctuation, deduplicated', () => {
  const text = 'Spec (https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit), demo: https://youtu.be/dQw4w9WgXcQ.\n' +
    'https://youtu.be/dQw4w9WgXcQ';
  assert.deepStrictEqual(extractUrls(text), [
    'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit',
    'https://youtu.be/dQw4w9WgXcQ'
  ]);
});
