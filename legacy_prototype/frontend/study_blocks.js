/* ══════════════════════════════════════════════════════════════════
   study_blocks.js — Sprint Z Track B
   Parses and renders Study Mode answers.

   The model never emits HTML. It emits typed JSON inside fenced blocks:

       ```studyblock
       {"type":"card","title":"…","kicker":"…","body":"…",
        "howToUse":["…"],"usefulFor":"…"}
       ```

   Everything between fences is ordinary markdown and still goes through
   marked + DOMPurify. Anything inside a block is escaped by hand here —
   no field is ever trusted as markup. Malformed JSON degrades to a plain
   code block instead of breaking the message.

   Public API (window.StudyBlocks):
     has(text)              → boolean, does this text contain any block?
     parse(text)            → array of {kind:'prose'|'block'|'fallback', …}
     renderToHTML(text)     → HTML string
     render(container, text)→ renders into an element and wires interactions

   Shared-JS pattern (survives design-tool regen with one re-added
   <script> include). It also injects its own stylesheet link.
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var BLOCK_TYPES = ['card', 'flow', 'compare', 'steps', 'note', 'keyterms', 'formula', 'checkpoint', 'takeaway'];
  var FENCE_RE = /```[ \t]*studyblock[ \t]*\r?\n([\s\S]*?)```/g;

  // ── stylesheet self-install ──────────────────────────────────────
  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-study-blocks]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'study_blocks.css';
    link.setAttribute('data-study-blocks', '1');
    document.head.appendChild(link);
  }

  // ── escaping ─────────────────────────────────────────────────────
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Tiny inline formatter. Runs AFTER esc(), so the input is already inert
  // and these are the only tags that can ever appear in a block field.
  function inline(v) {
    return esc(v)
      .replace(/`([^`]+)`/g, '<code class="sb-inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\r?\n/g, '<br>');
  }

  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x !== null && x !== undefined && String(x).trim() !== ''; }) : []; }
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }

  // ── parsing ──────────────────────────────────────────────────────

  // A fence may hold one object, an array of objects, or several objects
  // back to back. Returns an array of candidate objects, or null.
  function parsePayload(raw) {
    var text = String(raw || '').trim();
    if (!text) return null;

    try {
      var direct = JSON.parse(text);
      if (Array.isArray(direct)) return direct.filter(isPlainObject);
      if (isPlainObject(direct)) return [direct];
      return null;
    } catch (e) { /* fall through to the scanner */ }

    // Brace scanner: pull out top-level {...} runs, ignoring braces that
    // live inside strings. Handles "several objects in one fence" and
    // trailing prose the model appended by mistake.
    var out = [];
    var depth = 0, start = -1, inStr = false, escNext = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (c === '\\') escNext = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            var obj = JSON.parse(text.slice(start, i + 1));
            if (isPlainObject(obj)) out.push(obj);
          } catch (e2) { /* skip this run */ }
          start = -1;
        }
        if (depth < 0) depth = 0;
      }
    }
    return out.length ? out : null;
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isKnownBlock(o) {
    return isPlainObject(o) && BLOCK_TYPES.indexOf(str(o.type).toLowerCase().trim()) !== -1;
  }

  // Models drop the fence. Observed live: a model produced a flawless card
  // object but emitted it bare, which would have shown the user raw JSON.
  // So any top-level {...} whose "type" is one of the nine is promoted to a
  // block wherever it appears. The `type` check is what keeps this from
  // hijacking unrelated JSON the user was actually asking about.
  function rescueProse(text, out) {
    var src = str(text);
    var depth = 0, start = -1, inStr = false, escNext = false, cursor = 0;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (c === '\\') escNext = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; continue; }
      if (c !== '}') continue;
      depth--;
      if (depth > 0) continue;
      if (depth < 0) { depth = 0; continue; }
      if (start < 0) continue;
      var obj = null;
      try { obj = JSON.parse(src.slice(start, i + 1)); } catch (e) { obj = null; }
      if (isKnownBlock(obj)) {
        if (start > cursor) out.push({ kind: 'prose', text: src.slice(cursor, start) });
        out.push({ kind: 'block', block: obj });
        cursor = i + 1;
      }
      start = -1;
    }
    if (cursor < src.length) out.push({ kind: 'prose', text: src.slice(cursor) });
  }

  // A generic fence (```json, or an untagged one) holding nothing but block
  // objects is treated as if it had been tagged `studyblock`. Without this the
  // rescue above would promote the objects but leave orphaned backticks behind.
  var ANY_FENCE_RE = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

  function normalizeFences(src) {
    ANY_FENCE_RE.lastIndex = 0;
    return src.replace(ANY_FENCE_RE, function (whole, lang, payload) {
      if (String(lang).toLowerCase() === 'studyblock') return whole;
      var blocks = parsePayload(payload);
      if (blocks && blocks.length && blocks.every(isKnownBlock)) {
        return '```studyblock\n' + payload.replace(/\s+$/, '') + '\n```';
      }
      return whole;
    });
  }

  /**
   * Split a message into ordered segments.
   * @returns {Array<{kind:'prose',text:string}|{kind:'block',block:object}|{kind:'fallback',text:string}>}
   */
  function parse(text) {
    var src = normalizeFences(str(text));
    var segments = [];
    var last = 0;
    var m;
    FENCE_RE.lastIndex = 0;

    while ((m = FENCE_RE.exec(src)) !== null) {
      if (m.index > last) rescueProse(src.slice(last, m.index), segments);
      var blocks = parsePayload(m[1]);
      if (blocks && blocks.length) {
        for (var i = 0; i < blocks.length; i++) segments.push({ kind: 'block', block: blocks[i] });
      } else {
        segments.push({ kind: 'fallback', text: m[1] });
      }
      last = m.index + m[0].length;
    }
    if (last < src.length) rescueProse(src.slice(last), segments);
    return segments;
  }

  // True when the message should be rendered as study cards. A `studyblock`
  // fence is the fast path; otherwise fall back to a full parse, which also
  // catches the unfenced/mis-fenced output the rescue above handles. The cheap
  // brace test keeps ordinary prose from paying for a parse.
  function has(text) {
    var src = str(text);
    FENCE_RE.lastIndex = 0;
    if (FENCE_RE.test(src)) return true;
    if (src.indexOf('{') === -1 || src.indexOf('"type"') === -1) return false;
    return parse(src).some(function (s) { return s.kind === 'block'; });
  }

  // ── block renderers ──────────────────────────────────────────────

  function head(b) {
    var out = '';
    if (str(b.kicker).trim()) out += '<div class="sb-kicker">' + esc(b.kicker) + '</div>';
    if (str(b.title).trim()) out += '<h3 class="sb-title">' + esc(b.title) + '</h3>';
    return out;
  }

  var RENDERERS = {

    card: function (b) {
      var html = '<div class="sb-block sb-card">' + head(b);
      if (str(b.body).trim()) html += '<div class="sb-body">' + inline(b.body) + '</div>';
      var steps = arr(b.howToUse);
      if (steps.length) {
        html += '<div class="sb-label">How to use it</div><ul class="sb-howto">';
        for (var i = 0; i < steps.length; i++) html += '<li>' + inline(steps[i]) + '</li>';
        html += '</ul>';
      }
      if (str(b.usefulFor).trim()) {
        html += '<div class="sb-usefulfor"><b>Useful for</b>' + esc(b.usefulFor) + '</div>';
      }
      return html + '</div>';
    },

    flow: function (b) {
      var steps = arr(b.steps).map(function (s) { return isPlainObject(s) ? str(s.label || s.text) : str(s); });
      var html = '<div class="sb-block sb-flow">' + head(b) + '<div class="sb-flow-track">';
      for (var i = 0; i < steps.length; i++) {
        if (i > 0) html += '<span class="sb-flow-arrow" aria-hidden="true">&rarr;</span>';
        html += '<div class="sb-flow-step">' + esc(steps[i]) + '</div>';
      }
      html += '</div>';
      if (str(b.caption).trim()) html += '<div class="sb-caption">' + inline(b.caption) + '</div>';
      return html + '</div>';
    },

    compare: function (b) {
      var left = isPlainObject(b.left) ? b.left : { label: str(b.left) };
      var right = isPlainObject(b.right) ? b.right : { label: str(b.right) };
      var html = '<div class="sb-block sb-compare">' + head(b) +
        '<div class="sb-compare-grid">' +
          '<div class="sb-compare-side bad">' +
            '<div class="sb-compare-mark" aria-hidden="true">&#10007;</div>' +
            '<div class="sb-compare-head">' + esc(left.label) + '</div>' +
            (str(left.text).trim() ? '<div class="sb-compare-text">' + inline(left.text) + '</div>' : '') +
          '</div>' +
          '<span class="sb-compare-arrow" aria-hidden="true">&rarr;</span>' +
          '<div class="sb-compare-side good">' +
            '<div class="sb-compare-mark" aria-hidden="true">&#10003;</div>' +
            '<div class="sb-compare-head">' + esc(right.label) + '</div>' +
            (str(right.text).trim() ? '<div class="sb-compare-text">' + inline(right.text) + '</div>' : '') +
          '</div>' +
        '</div>';
      if (str(b.caption).trim()) html += '<div class="sb-caption">' + inline(b.caption) + '</div>';
      return html + '</div>';
    },

    steps: function (b) {
      var items = arr(b.steps);
      var html = '<div class="sb-block sb-stepsblock">' + head(b) + '<ol class="sb-steps">';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var label = isPlainObject(it) ? str(it.label || it.title) : '';
        var body = isPlainObject(it) ? str(it.text || it.detail) : str(it);
        html += '<li data-n="' + (i + 1) + '">' +
          (label ? '<span class="sb-step-head">' + esc(label) + '</span>' : '') +
          inline(body) + '</li>';
      }
      return html + '</ol></div>';
    },

    note: function (b) {
      return '<div class="sb-block sb-note">' +
        (str(b.title).trim() ? '<span class="sb-note-label">' + esc(b.title) + '</span>' : '') +
        inline(b.body || b.text) + '</div>';
    },

    keyterms: function (b) {
      var terms = arr(b.terms).map(function (t) {
        return isPlainObject(t) ? { term: str(t.term || t.label), def: str(t.definition || t.def || t.text) }
                                : { term: str(t), def: '' };
      });
      var html = '<div class="sb-block sb-keyterms">' + head(b) + '<div class="sb-terms">';
      for (var i = 0; i < terms.length; i++) {
        html += '<button type="button" class="sb-term" data-sb-term="' + i + '" aria-expanded="false">' + esc(terms[i].term) + '</button>';
      }
      html += '</div><div class="sb-term-defs">';
      for (var j = 0; j < terms.length; j++) {
        html += '<div class="sb-term-def" data-sb-def="' + j + '"><b>' + esc(terms[j].term) + '</b> — ' + inline(terms[j].def) + '</div>';
      }
      return html + '</div></div>';
    },

    formula: function (b) {
      var legend = arr(b.legend).map(function (l) {
        return isPlainObject(l) ? { sym: str(l.symbol || l.term), means: str(l.meaning || l.text || l.definition) }
                                : { sym: '', means: str(l) };
      });
      var html = '<div class="sb-block sb-formula">' + head(b) +
        '<div class="sb-formula-box">' + esc(b.expression || b.formula) + '</div>';
      if (legend.length) {
        html += '<ul class="sb-legend">';
        for (var i = 0; i < legend.length; i++) {
          html += '<li>' + (legend[i].sym ? '<code>' + esc(legend[i].sym) + '</code>' : '') + inline(legend[i].means) + '</li>';
        }
        html += '</ul>';
      }
      if (str(b.caption).trim()) html += '<div class="sb-caption">' + inline(b.caption) + '</div>';
      return html + '</div>';
    },

    checkpoint: function (b) {
      var qs = arr(b.questions).map(function (q) {
        return isPlainObject(q) ? { q: str(q.question || q.q), a: str(q.answer || q.a) } : { q: str(q), a: '' };
      });
      var html = '<div class="sb-block sb-checkpoint">' +
        '<div class="sb-kicker">' + esc(str(b.kicker).trim() || 'Check yourself') + '</div>' +
        (str(b.title).trim() ? '<h3 class="sb-title">' + esc(b.title) + '</h3>' : '') +
        '<ul class="sb-check-list">';
      for (var i = 0; i < qs.length; i++) {
        html += '<li>' +
          '<div class="sb-check-q">' + inline(qs[i].q) + '</div>' +
          (qs[i].a
            ? '<button type="button" class="sb-reveal" data-sb-reveal="' + i + '">Show answer</button>' +
              '<div class="sb-answer" data-sb-answer="' + i + '">' + inline(qs[i].a) + '</div>'
            : '') +
          '</li>';
      }
      return html + '</ul></div>';
    },

    takeaway: function (b) {
      var html = '<div class="sb-block sb-takeaway">' +
        '<div class="sb-kicker">' + esc(str(b.kicker).trim() || 'Takeaway') + '</div>' +
        (str(b.title).trim() ? '<h3 class="sb-title">' + esc(b.title) + '</h3>' : '');
      if (str(b.body).trim()) html += '<div class="sb-body">' + inline(b.body) + '</div>';
      var pts = arr(b.points);
      if (pts.length) {
        html += '<ul class="sb-howto" style="margin-top:10px;">';
        for (var i = 0; i < pts.length; i++) html += '<li>' + inline(pts[i]) + '</li>';
        html += '</ul>';
      }
      return html + '</div>';
    }
  };

  function renderBlock(b) {
    var type = str(b && b.type).toLowerCase().trim();
    if (BLOCK_TYPES.indexOf(type) === -1 || !RENDERERS[type]) {
      // Unknown type: show the payload rather than silently dropping content.
      return fallbackHTML(JSON.stringify(b, null, 2), 'Unrecognised block type "' + esc(type || 'missing') + '" — showing raw data.');
    }
    try {
      return RENDERERS[type](b);
    } catch (e) {
      return fallbackHTML(JSON.stringify(b, null, 2), 'Could not render this block.');
    }
  }

  function fallbackHTML(raw, note) {
    return '<div class="sb-fallback">' +
      '<div class="sb-fallback-note">' + (note || 'Malformed study block — showing raw output.') + '</div>' +
      '<pre>' + esc(raw) + '</pre></div>';
  }

  // Prose still goes through the page's markdown pipeline when available.
  function proseHTML(text) {
    var t = str(text);
    if (!t.trim()) return '';
    if (global.marked && global.DOMPurify) {
      return '<div class="sb-prose">' +
        global.DOMPurify.sanitize(global.marked.parse(t), { ADD_ATTR: ['target'] }) +
        '</div>';
    }
    return '<div class="sb-prose">' + inline(t) + '</div>';
  }

  // ── public render ────────────────────────────────────────────────

  function renderToHTML(text) {
    var segs = parse(text);
    var out = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.kind === 'prose') out += proseHTML(s.text);
      else if (s.kind === 'block') out += renderBlock(s.block);
      else out += fallbackHTML(s.text);
    }
    return '<div class="sb-root">' + out + '</div>';
  }

  function render(container, text) {
    if (!container) return;
    ensureStyles();
    container.innerHTML = renderToHTML(text);
    return container;
  }

  // Reveal buttons and key-term chips. Delegated ONCE at the document level,
  // not per container: the chat page caches rendered conversations as HTML
  // strings and re-inserts them, which would strip any per-node listeners.
  var wired = false;
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('click', function (ev) {
      if (!ev.target || !ev.target.closest) return;
      var revealBtn = ev.target.closest('[data-sb-reveal]');
      if (revealBtn) {
        var block = revealBtn.closest('.sb-checkpoint');
        var ans = block && block.querySelector('[data-sb-answer="' + revealBtn.getAttribute('data-sb-reveal') + '"]');
        if (ans) {
          var open = ans.classList.toggle('open');
          revealBtn.textContent = open ? 'Hide answer' : 'Show answer';
        }
        return;
      }
      var termBtn = ev.target.closest('[data-sb-term]');
      if (termBtn) {
        var kt = termBtn.closest('.sb-keyterms');
        var def = kt && kt.querySelector('[data-sb-def="' + termBtn.getAttribute('data-sb-term') + '"]');
        if (def) {
          var shown = def.classList.toggle('open');
          termBtn.setAttribute('aria-expanded', shown ? 'true' : 'false');
        }
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { ensureStyles(); wire(); });
    } else {
      ensureStyles();
      wire();
    }
  }

  // Flatten an answer back to plain text — used when handing a study answer to
  // the knowledge pipeline (/api/knowledge/ingest-document), which wants prose,
  // not JSON.
  function toText(text) {
    var segs = parse(text);
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.kind === 'prose') { if (s.text.trim()) out.push(s.text.trim()); continue; }
      if (s.kind !== 'block') { out.push(s.text); continue; }
      var b = s.block, lines = [];
      if (str(b.title).trim()) lines.push('## ' + b.title);
      if (str(b.kicker).trim()) lines.push(str(b.kicker));
      if (str(b.body).trim()) lines.push(str(b.body));
      if (str(b.text).trim()) lines.push(str(b.text));
      if (str(b.expression || b.formula).trim()) lines.push(str(b.expression || b.formula));
      arr(b.howToUse).forEach(function (x) { lines.push('- ' + x); });
      arr(b.points).forEach(function (x) { lines.push('- ' + x); });
      arr(b.steps).forEach(function (x, n) {
        lines.push((n + 1) + '. ' + (isPlainObject(x) ? [x.label, x.text || x.detail].filter(Boolean).join(' — ') : x));
      });
      arr(b.terms).forEach(function (t) {
        lines.push('- ' + (isPlainObject(t) ? t.term + ': ' + (t.definition || t.def || '') : t));
      });
      arr(b.legend).forEach(function (l) {
        lines.push('- ' + (isPlainObject(l) ? l.symbol + ' = ' + (l.meaning || '') : l));
      });
      arr(b.questions).forEach(function (q) {
        lines.push('Q: ' + (isPlainObject(q) ? q.question : q));
        if (isPlainObject(q) && q.answer) lines.push('A: ' + q.answer);
      });
      if (isPlainObject(b.left)) lines.push('✗ ' + str(b.left.label) + (b.left.text ? ' — ' + b.left.text : ''));
      if (isPlainObject(b.right)) lines.push('✓ ' + str(b.right.label) + (b.right.text ? ' — ' + b.right.text : ''));
      if (str(b.caption).trim()) lines.push(str(b.caption));
      if (str(b.usefulFor).trim()) lines.push('Useful for: ' + b.usefulFor);
      out.push(lines.join('\n'));
    }
    return out.join('\n\n').trim();
  }

  var API = {
    BLOCK_TYPES: BLOCK_TYPES,
    has: has,
    parse: parse,
    toText: toText,
    renderToHTML: renderToHTML,
    render: render,
    _esc: esc
  };

  global.StudyBlocks = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
