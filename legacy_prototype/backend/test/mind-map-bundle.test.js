// test/mind-map-bundle.test.js — the shareable mind map file format.
//
// A bundle has to survive two readers: another app opening map.canvas (JSON
// Canvas 1.0), and FinChat importing finchat-map.json. And an import has to
// survive a bundle written by someone hostile.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const Bundle = require('../services/cognitive/mindMapBundle');

function sampleMap() {
  const n = (id, parent, label, extra = {}) => ({
    node_id: id, parent_id: parent, label, summary: `${label} in one line`, detail: '',
    node_type: parent ? 'leaf' : 'root', color: null, icon: null, collapsed: false,
    x: null, y: null, order_index: 0, ...extra
  });
  return {
    map: { map_id: 'mm_1', title: 'Options Greeks', topic: 'greeks', layout: 'radial', theme: 'warm' },
    nodes: [
      n('r', null, 'Greeks'),
      n('a', 'r', 'Delta', { node_type: 'branch', color: '#c67139', order_index: 0 }),
      n('b', 'r', 'Gamma', { node_type: 'branch', order_index: 1, x: 40, y: 80 }),
      n('a1', 'a', 'Hedge ratio', { detail: 'How many shares offset one option.' })
    ],
    edges: [{ edge_id: 'e1', from_node: 'a1', to_node: 'b', label: 'changes with', style: 'dashed' }],
    docs: [
      { doc_id: 'd1', node_id: 'a', filename: 'hull ch19.pdf', kind: 'document', mimetype: 'application/pdf',
        extracted: 'Delta is the rate of change…', data: Buffer.from('%PDF-1.4 fake') },
      { doc_id: 'd2', node_id: 'a1', filename: 'my note', kind: 'text', mimetype: 'text/plain',
        extracted: 'Rebalance daily.', data: null },
      { doc_id: 'd3', node_id: null, filename: 'huge scan.pdf', kind: 'document', mimetype: 'application/pdf',
        extracted: 'Only the text survived.', data: null },
      { doc_id: 'd4', node_id: 'b', filename: 'hull ch19.pdf', kind: 'document', mimetype: 'application/pdf',
        extracted: 'Second copy, same name.', data: Buffer.from('%PDF-1.4 other') },
      { doc_id: 'd5', node_id: 'a1', filename: 'Hedging walkthrough', kind: 'link', mimetype: '',
        extracted: '', data: null, url: 'https://youtu.be/dQw4w9WgXcQ', provider: 'youtube' }
    ]
  };
}

async function zipOf(files) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('export', () => {
  test('the zip holds a canvas, the manifest, and every document under one folder', async () => {
    const { buffer, filename } = await Bundle.buildBundle(sampleMap());
    assert.strictEqual(filename, 'options-greeks.zip');
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir).sort();
    assert.deepStrictEqual(names, [
      'options-greeks/README.txt',
      'options-greeks/files/huge scan.pdf (text).txt',
      'options-greeks/files/hull ch19 (2).pdf',
      'options-greeks/files/hull ch19.pdf',
      'options-greeks/files/my note.md',
      'options-greeks/finchat-map.json',
      'options-greeks/map.canvas'
    ]);
    assert.strictEqual(await zip.file('options-greeks/files/hull ch19.pdf').async('string'), '%PDF-1.4 fake');
    assert.strictEqual(await zip.file('options-greeks/files/my note.md').async('string'), 'Rebalance daily.');
  });

  test('map.canvas is valid JSON Canvas with documents as file nodes at vault-relative paths', async () => {
    const m = sampleMap();
    const planned = Bundle.planFiles(m.docs, 'options-greeks');
    const canvas = Bundle.toCanvas(m, planned);
    const ids = new Set(canvas.nodes.map(n => n.id));
    for (const n of canvas.nodes) {
      for (const k of ['id', 'type', 'x', 'y', 'width', 'height']) assert.ok(n[k] !== undefined, `${n.id} missing ${k}`);
      assert.ok(['text', 'file', 'link'].includes(n.type));
    }
    // A link is a JSON Canvas link node, never a file in the zip.
    const linkNodes = canvas.nodes.filter(n => n.type === 'link');
    assert.deepStrictEqual(linkNodes.map(n => n.url), ['https://youtu.be/dQw4w9WgXcQ']);
    assert.ok(canvas.edges.some(e => e.fromNode === 'a1' && e.toNode === linkNodes[0].id));
    for (const e of canvas.edges) {
      assert.ok(ids.has(e.fromNode) && ids.has(e.toNode), `edge ${e.id} dangles`);
    }
    const files = canvas.nodes.filter(n => n.type === 'file').map(n => n.file).sort();
    assert.strictEqual(files.length, 4);
    assert.ok(files.every(f => f.startsWith('options-greeks/files/')));
    // The cross-link keeps its label.
    assert.ok(canvas.edges.some(e => e.fromNode === 'a1' && e.toNode === 'b' && e.label === 'changes with'));
  });
});

describe('import', () => {
  test('a bundle round-trips: structure, detail, pins, colours, cross-links and originals', async () => {
    const { buffer } = await Bundle.buildBundle(sampleMap());
    const p = await Bundle.parseBundle(buffer);
    assert.strictEqual(p.map.title, 'Options Greeks');
    assert.deepStrictEqual(p.nodes.map(n => n.label), ['Greeks', 'Delta', 'Gamma', 'Hedge ratio']);
    assert.strictEqual(p.nodes[0].parentRef, null);
    assert.strictEqual(p.nodes.find(n => n.label === 'Delta').color, '#c67139');
    assert.strictEqual(p.nodes.find(n => n.label === 'Gamma').x, 40);
    assert.strictEqual(p.nodes.find(n => n.label === 'Hedge ratio').detail, 'How many shares offset one option.');
    assert.deepStrictEqual(p.edges.map(e => [e.fromRef, e.toRef]), [['a1', 'b']]);

    const pdf = p.docs.find(d => d.nodeRef === 'a');
    assert.strictEqual(pdf.data.toString(), '%PDF-1.4 fake');
    assert.strictEqual(pdf.mimetype, 'application/pdf');
    const note = p.docs.find(d => d.kind === 'text');
    assert.strictEqual(note.text, 'Rebalance daily.');
    assert.strictEqual(note.data, null);
    // Too big to have been kept: arrives as text, still attached to the map.
    const scan = p.docs.find(d => d.filename === 'huge scan.pdf');
    assert.strictEqual(scan.data, null);
    assert.strictEqual(scan.nodeRef, null);
    assert.strictEqual(scan.text, 'Only the text survived.');
    assert.strictEqual(p.docs.find(d => d.nodeRef === 'b').data.toString(), '%PDF-1.4 other');
    const link = p.docs.find(d => d.kind === 'link');
    assert.deepStrictEqual([link.nodeRef, link.filename, link.url, link.provider],
      ['a1', 'Hedging walkthrough', 'https://youtu.be/dQw4w9WgXcQ', 'youtube']);
  });

  test('a bundle "link" that is not http(s) is dropped, never stored', async () => {
    const manifest = {
      format: 'finchat-mindmap', version: 1, map: { title: 'T' },
      nodes: [{ id: 'r', parent: null, label: 'Root' }],
      docs: [
        { node: 'r', filename: 'x', kind: 'link', url: 'javascript:alert(1)' },
        { node: 'r', filename: 'ok', kind: 'link', url: 'https://duxbe.com/pos' }
      ]
    };
    const p = await Bundle.parseBundle(await zipOf({ 'finchat-map.json': JSON.stringify(manifest) }));
    assert.deepStrictEqual(p.docs.map(d => d.url), ['https://duxbe.com/pos']);
    assert.strictEqual(p.dropped.docs, 1);
  });

  test('a zip without finchat-map.json is refused with a reason', async () => {
    const buf = await zipOf({ 'x/map.canvas': '{}' });
    await assert.rejects(Bundle.parseBundle(buf), Bundle.BundleError);
    await assert.rejects(Bundle.parseBundle(Buffer.from('not a zip')), /not a zip/);
  });

  test('orphans and parent cycles never get in, and the root stays a root', async () => {
    const manifest = {
      format: 'finchat-mindmap', version: 1, map: { title: 'T' },
      nodes: [
        { id: 'r', parent: null, label: 'Root', type: 'leaf' },
        { id: 'k', parent: 'r', label: 'Kid', type: 'root' },
        { id: 'c1', parent: 'c2', label: 'Loop A' },
        { id: 'c2', parent: 'c1', label: 'Loop B' },
        { id: 'o', parent: 'ghost', label: 'Orphan' }
      ],
      edges: [{ from: 'k', to: 'c1' }, { from: 'k', to: 'k' }],
      docs: []
    };
    const p = await Bundle.parseBundle(await zipOf({ 'finchat-map.json': JSON.stringify(manifest) }));
    assert.deepStrictEqual(p.nodes.map(n => n.label), ['Root', 'Kid']);
    assert.strictEqual(p.nodes[0].type, 'root');
    assert.strictEqual(p.nodes[1].type, 'branch');
    assert.strictEqual(p.edges.length, 0);
    assert.strictEqual(p.dropped.nodes, 3);
  });

  test('two roots is refused', async () => {
    const manifest = { format: 'finchat-mindmap', version: 1,
      nodes: [{ id: 'a', parent: null, label: 'A' }, { id: 'b', parent: null, label: 'B' }] };
    await assert.rejects(Bundle.parseBundle(await zipOf({ 'finchat-map.json': JSON.stringify(manifest) })), /exactly one root/);
  });

  test('a file\'s type comes from its extension, never from the bundle', async () => {
    const manifest = {
      format: 'finchat-mindmap', version: 1, map: { title: 'T' },
      nodes: [{ id: 'r', parent: null, label: 'Root' }],
      docs: [
        { node: 'r', filename: 'page.html', kind: 'document', file: 'files/page.html', mimetype: 'text/html', text: '' },
        { node: 'r', filename: 'chart.png', kind: 'image', file: 'files/chart.png', text: '' },
        { node: 'r', filename: 'escape', kind: 'document', file: '../../etc/passwd', text: '' }
      ]
    };
    const p = await Bundle.parseBundle(await zipOf({
      'b/finchat-map.json': JSON.stringify(manifest),
      'b/files/page.html': '<script>alert(1)</script>',
      'b/files/chart.png': 'PNG'
    }));
    assert.strictEqual(p.docs.find(d => d.filename === 'page.html').mimetype, 'application/octet-stream');
    assert.strictEqual(p.docs.find(d => d.filename === 'chart.png').mimetype, 'image/png');
    // Nothing at that path inside the bundle, and no text: dropped, not resolved outside it.
    assert.strictEqual(p.docs.length, 2);
    assert.strictEqual(p.dropped.docs, 1);
  });

  test('a bundle from a newer format version is refused rather than half-read', async () => {
    const manifest = { format: 'finchat-mindmap', version: 99, nodes: [{ id: 'r', parent: null, label: 'R' }] };
    await assert.rejects(Bundle.parseBundle(await zipOf({ 'finchat-map.json': JSON.stringify(manifest) })), /newer FinChat/);
  });
});
