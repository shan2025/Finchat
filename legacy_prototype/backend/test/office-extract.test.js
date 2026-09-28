// test/office-extract.test.js — PowerPoint and Excel text extraction, on tiny
// files built here with jszip (the same zip-of-XML shape Office writes).
const { test } = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { extractPptx, extractXlsx, extractFromUpload } = require('../services/attachments');

async function pptx() {
  const z = new JSZip();
  const slide = (t) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  z.file('ppt/slides/slide2.xml', slide('Phase 2: GCC launch &amp; Arabic'));
  z.file('ppt/slides/slide1.xml', slide('Beta by 3 October'));
  z.file('ppt/slides/slide10.xml', slide('Thanks'));
  z.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><a:p><a:r><a:t>Recruit 20 businesses</a:t></a:r></a:p></p:notes>');
  return z.generateAsync({ type: 'nodebuffer' });
}

async function xlsx() {
  const z = new JSZip();
  z.file('xl/sharedStrings.xml', '<sst><si><t>Task</t></si><si><t>Due</t></si><si><t>Order scanners</t></si></sst>');
  z.file('xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>46307</v></c><c r="C2" t="inlineStr"><is><t>Anil</t></is></c></row></sheetData></worksheet>');
  return z.generateAsync({ type: 'nodebuffer' });
}

test('PowerPoint: slides in numeric order (1, 2, 10), entities decoded, speaker notes kept', async () => {
  const text = await extractPptx(await pptx());
  assert.match(text, /^Slide 1:\nBeta by 3 October\nNotes: Recruit 20 businesses/);
  assert.ok(text.indexOf('Slide 2:') < text.indexOf('Slide 10:'));
  assert.match(text, /GCC launch & Arabic/);
});

test('Excel: shared and inline strings resolved, one tab-separated row per line', async () => {
  const text = await extractXlsx(await xlsx());
  assert.strictEqual(text, 'Sheet 1:\nTask\tDue\nOrder scanners\t46307\tAnil');
});

test('uploads route .pptx and .xlsx to the new readers', async () => {
  const p = await extractFromUpload({ buffer: await pptx(), originalname: 'roadmap.pptx', mimetype: 'application/octet-stream', size: 1 });
  assert.strictEqual(p.kind, 'document');
  assert.match(p.text, /Beta by 3 October/);
  const x = await extractFromUpload({ buffer: await xlsx(), originalname: 'tasks.xlsx', mimetype: '', size: 1 });
  assert.strictEqual(x.kind, 'document');
  assert.match(x.text, /Order scanners/);
});
