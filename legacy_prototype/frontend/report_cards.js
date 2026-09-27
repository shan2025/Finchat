/* ══════════════════════════════════════════════════════════════════
   report_cards.js — daily briefs and reports as a swipeable card deck.

   A briefing arrives as one long markdown document (see BRIEFING_GOAL in
   backend/services/briefing.js): an H1 title, an Executive Summary, one H3
   per story with an H4 subtitle and a "Why it matters" paragraph, a Key
   Takeaway and a block of numbered reference links. Rendered as a single
   chat bubble it is a wall of text nobody wants to open three times a day.

   This turns that same markdown into editorial cards, one idea per card:
   small spaced kicker, a serif headline, short sans body, a mono tagline and
   a 3/9 counter — the carousel look of a paged social post. Nothing about the
   stored message changes, so every brief already in the database renders
   this way too, and Telegram/email still get the plain text.

   The model's text is never trusted as markup: headings are escaped by hand
   and every body fragment goes through marked + DOMPurify, same as chat.

   Public API (window.ReportCards):
     has(text)               → boolean, is this a report-shaped document?
     parse(text)             → { title, date, slides:[…], refs }
     renderToHTML(text)      → HTML string
     render(container, text) → renders into an element

   Interactions are delegated at the document level because chat caches
   conversations as HTML strings and re-inserts them, which drops per-node
   listeners (the same reason study_blocks.js does it).
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-report-cards]')) return;
    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&display=swap';
    fonts.setAttribute('data-report-cards', 'fonts');
    document.head.appendChild(fonts);
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'report_cards.css';
    link.setAttribute('data-report-cards', '1');
    document.head.appendChild(link);
  }

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Headings arrive decorated ("🧠 Frontier…", "₿ Crypto & Blockchain",
  // "**Nvidia**"). Emoji look wrong in a serif headline, so strip leading
  // symbols and markdown emphasis; the words carry the meaning.
  function cleanHeading(h) {
    return String(h || '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^[^\p{L}\p{N}"'“‘(]+/u, '')
      .replace(/[\s:—-]+$/, '')
      .trim();
  }

  var TITLE_WORDS = /\b(brief|briefing|report|digest|news|newsletter|update|review|roundup|recap|outlook|wrap)\b/i;
  var SUMMARY_RE = /^(executive summary|summary|the headlines|headlines|at a glance|tl;?dr|top signals|key signals)\b/i;
  var CLOSING_RE = /^(key takeaways?|the takeaway|bottom line|conclusion|final word|what to watch)\b/i;
  var SOURCES_RE = /^(sources|references|citations|further reading)\b/i;
  var REF_DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s+(\S+)(?:\s+["'(](.*?)["')])?\s*$/;
  var WHY_RE = /^\s*(?:[-*]\s*)?\*\*\s*why it matters\s*[:—–-]?\s*\*\*\s*[:—–-]?\s*/i;
  var TAG_RE = /^\s*[*_]*\s*(?:in short|tagline|in a line|one line)\s*[:—–-]\s*(.+?)\s*[*_]*\s*$/i;

  function isReport(text) {
    if (!text || text.length < 900) return false;
    if (/```[ \t]*studyblock/.test(text)) return false;
    var h1 = text.match(/^#\s+(.+)$/m);
    var sections = (text.match(/^#{2,3}\s+\S/gm) || []).length;
    if (sections < 3) return false;
    if (h1 && TITLE_WORDS.test(h1[1])) return true;
    // No titled H1: still a report when it carries both bookends.
    return /^##\s+.*executive summary/im.test(text) && /^##\s+.*(key takeaway|bottom line)/im.test(text);
  }

  function parse(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var refs = [];
    var body = [];
    lines.forEach(function (ln) {
      var m = ln.match(REF_DEF_RE);
      if (m) refs.push({ id: m[1], url: m[2], title: m[3] || '' , raw: ln.trim() });
      else body.push(ln);
    });

    var title = '', date = '', intro = [];
    var slides = [];
    var section = '';
    var cur = null;
    var inFence = false;

    function open(kind, kicker, headline) {
      close();
      cur = { kind: kind, kicker: kicker, headline: headline, sub: '', lines: [] };
    }
    function close() {
      if (!cur) return;
      var hasText = cur.lines.join('').trim().length > 0;
      // An H2 used only as a group label for the H3s under it has no text of
      // its own — its name lives on as their kicker instead of an empty card.
      if (hasText || cur.sub) slides.push(cur);
      cur = null;
    }

    body.forEach(function (ln) {
      if (/^\s*```/.test(ln)) inFence = !inFence;
      var h = !inFence && ln.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (h) {
        var level = h[1].length, txt = h[2];
        if (level === 1 && !title) {
          var parts = cleanHeading(txt).split(/\s+[—–|-]\s+/);
          title = parts[0];
          date = parts.slice(1).join(' — ');
          return;
        }
        if (level <= 2) {
          section = cleanHeading(txt);
          var kind = SUMMARY_RE.test(section) ? 'summary'
            : CLOSING_RE.test(section) ? 'closing'
            : SOURCES_RE.test(section) ? 'sources' : 'story';
          open(kind, section, section);
          return;
        }
        if (level === 3) { open('story', section, cleanHeading(txt)); return; }
        // H4: the story's subtitle when it comes first, otherwise a bold line.
        if (cur && !cur.sub && !cur.lines.join('').trim()) { cur.sub = cleanHeading(txt); return; }
        ln = '**' + cleanHeading(txt) + '**';
      }
      if (!inFence && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) return;
      if (cur) cur.lines.push(ln); else intro.push(ln);
    });
    close();

    // Pull "Why it matters" and a tagline out of each card's prose so they can
    // be laid out as their own elements instead of more paragraphs.
    slides.forEach(function (s) {
      var why = [], keep = [], tag = '', inWhy = false;
      s.lines.forEach(function (ln) {
        var t = ln.match(TAG_RE);
        if (t && !tag) { tag = t[1].replace(/[*_`]/g, ''); return; }
        if (WHY_RE.test(ln)) { inWhy = true; ln = ln.replace(WHY_RE, ''); }
        else if (inWhy && !ln.trim() && why.join('').trim()) inWhy = false;
        (inWhy ? why : keep).push(ln);
      });
      // Leading emoji on list items ("- 📈 **Apple…") fight the card's type.
      keep = keep.map(function (ln) {
        return ln.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)[^\p{L}\p{N}\s*_"'“‘(\[$€£₹+~−-]+\s*/u, '$1');
      });
      s.body = keep.join('\n').trim();
      s.why = why.join('\n').trim();
      s.tag = tag;
    });

    if (!slides.some(function (s) { return s.kind === 'sources'; }) && refs.length) {
      slides.push({ kind: 'sources', kicker: 'Sources', headline: 'Where this comes from', body: '', why: '', tag: '' });
    }
    return { title: title, date: date, intro: intro.join('\n').trim(), slides: slides, refs: refs };
  }

  // Bodies keep their reference-style links ("([Reuters][3])"), so the
  // definitions are appended to every fragment before it is parsed.
  function md(src, refs) {
    if (!src) return '';
    // A citation to a reference the model never defined stays as literal
    // "([3])"; show it as a plain "(3)" instead of stray brackets.
    var ids = {};
    refs.forEach(function (r) { ids[r.id] = 1; });
    src = src.replace(/(?<!\])\[(\d+)\](?![\[(:])/g, function (m, n) { return ids[n] ? m : n; });
    var full = src + (refs.length ? '\n\n' + refs.map(function (r) { return r.raw; }).join('\n') : '');
    if (global.marked && global.DOMPurify) {
      var html = global.DOMPurify.sanitize(global.marked.parse(full), { ADD_ATTR: ['target'] });
      return html.replace(/<a /g, '<a target="_blank" rel="noopener" ');
    }
    return '<p>' + esc(src) + '</p>';
  }

  function plainLen(s) { return String(s || '').replace(/\[[^\]]*\]\[[^\]]*\]|[*_#>`]/g, '').length; }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }

  function card(inner, i, n, extra) {
    return '<article class="rc-card' + (extra ? ' ' + extra : '') + '" data-rc-card>' +
      '<span class="rc-count">' + (i + 1) + '/' + n + '</span>' + inner + '</article>';
  }

  function kicker(t) {
    return '<div class="rc-orn" aria-hidden="true"><i></i><b></b><i></i></div>' +
      '<div class="rc-kicker">' + esc(t) + '</div>';
  }

  function renderToHTML(text) {
    var d = parse(text);
    var refs = d.refs;
    var stories = d.slides.filter(function (s) { return s.kind === 'story'; });
    var n = d.slides.length + 1;
    var out = [];

    // Cover: title, date and a contents list, so the first card already says
    // whether today's brief is worth swiping through.
    var toc = stories.slice(0, 7).map(function (s, i) {
      return '<li><span>' + String(i + 1).padStart(2, '0') + '</span>' + esc(s.headline) + '</li>';
    }).join('');
    out.push(card(
      kicker(d.date || 'Today') +
      '<h2 class="rc-title rc-title-xl">' + esc(d.title || 'The Brief') + '</h2>' +
      (d.intro ? '<div class="rc-body rc-center">' + md(d.intro, refs) + '</div>' : '') +
      (toc ? '<div class="rc-toc-label">In this issue</div><ol class="rc-toc">' + toc + '</ol>' : '') +
      '<div class="rc-tag">' + stories.length + ' stories · swipe to read</div>',
      0, n, 'rc-cover'));

    d.slides.forEach(function (s, idx) {
      var i = idx + 1, html;
      if (s.kind === 'summary') {
        html = kicker('The headlines') +
          '<h3 class="rc-title">' + esc(s.headline === 'Executive Summary' ? 'Today in brief' : s.headline) + '</h3>' +
          '<div class="rc-body rc-signals">' + md(s.body, refs) + '</div>' +
          '<div class="rc-tag">' + esc(s.tag || 'Strongest signals first') + '</div>';
        out.push(card(html, i, n, 'rc-summary'));
      } else if (s.kind === 'closing') {
        html = kicker(s.kicker) +
          '<h3 class="rc-title">' + esc(s.headline === s.kicker ? 'The thread that ties it together' : s.headline) + '</h3>' +
          '<div class="rc-body rc-center">' + md(s.body || s.why, refs) + '</div>' +
          '<div class="rc-tag">' + esc(s.tag || 'Connect the dots') + '</div>';
        out.push(card(html, i, n, 'rc-closing'));
      } else if (s.kind === 'sources') {
        var list = refs.map(function (r) {
          return '<li><span>' + esc(r.id) + '</span><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
            esc(r.title || hostOf(r.url)) + '<small>' + esc(hostOf(r.url)) + '</small></a></li>';
        }).join('');
        html = kicker('Sources') + '<h3 class="rc-title">' + esc(s.headline) + '</h3>' +
          (list ? '<ol class="rc-refs">' + list + '</ol>' : '<div class="rc-body">' + md(s.body, refs) + '</div>') +
          '<div class="rc-tag">Check the claim, not the tone</div>';
        out.push(card(html, i, n, 'rc-sources'));
      } else {
        var long = plainLen(s.body) > 480;
        html = kicker(s.kicker && s.kicker !== s.headline ? s.kicker : 'Story ' + String(stories.indexOf(s) + 1).padStart(2, '0')) +
          '<h3 class="rc-title">' + esc(s.headline) + '</h3>' +
          (s.sub ? '<p class="rc-sub">' + esc(s.sub) + '</p>' : '') +
          '<div class="rc-body' + (long ? ' rc-clamp' : '') + '">' + md(s.body, refs) + '</div>' +
          (long ? '<button type="button" class="rc-more" data-rc-more>Continue reading</button>' : '') +
          (s.why ? '<div class="rc-why"><div class="rc-why-label">Why it matters</div>' + md(s.why, refs) + '</div>' : '') +
          (s.tag ? '<div class="rc-tag">' + esc(s.tag) + '</div>' : '');
        out.push(card(html, i, n, 'rc-story'));
      }
    });

    var plain = md(text, []);
    return '<div class="rc-root" data-rc-root>' +
      '<div class="rc-track" tabindex="0" aria-label="' + esc(d.title || 'Report') + ', ' + n + ' cards">' + out.join('') + '</div>' +
      '<div class="rc-bar">' +
        '<button type="button" class="rc-nav" data-rc-step="-1" aria-label="Previous card">&#8592;</button>' +
        '<button type="button" class="rc-nav" data-rc-step="1" aria-label="Next card">&#8594;</button>' +
        '<span class="rc-hint">' + n + ' cards</span>' +
        '<button type="button" class="rc-toggle" data-rc-toggle>Read as text</button>' +
      '</div>' +
      '<div class="rc-text markdown-body">' + plain + '</div>' +
    '</div>';
  }

  function render(container, text) {
    if (!container) return;
    ensureStyles();
    container.innerHTML = renderToHTML(text);
    container.setAttribute('data-report', '1');
  }

  // Step to an exact card rather than scrollBy a width: a second press during
  // the smooth scroll would otherwise land between two cards.
  function stepDeck(track, dir) {
    var cards = track.querySelectorAll('[data-rc-card]');
    if (!cards.length) return;
    var base = cards[0].offsetLeft;
    var target = track.__rcIdx;
    // Mid-animation, trust the card we are heading to; otherwise the user
    // may have swiped, so find the card nearest the current scroll.
    if (!track.__rcMoving || target === undefined) {
      target = 0;
      cards.forEach(function (c, k) {
        if (Math.abs(c.offsetLeft - base - track.scrollLeft) < Math.abs(cards[target].offsetLeft - base - track.scrollLeft)) target = k;
      });
    }
    target = Math.max(0, Math.min(cards.length - 1, target + dir));
    track.__rcIdx = target;
    track.__rcMoving = true;
    clearTimeout(track.__rcTimer);
    track.__rcTimer = setTimeout(function () { track.__rcMoving = false; }, 600);
    track.scrollTo({ left: cards[target].offsetLeft - base, behavior: 'smooth' });
  }

  // The deck the arrow keys drive: the one being interacted with, else the
  // one taking up most of the viewport (a chat can hold several briefs).
  function activeTrack() {
    var focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-rc-root]');
    if (focused) return focused.querySelector('.rc-track');
    var best = null, bestArea = 0;
    document.querySelectorAll('[data-rc-root]:not(.rc-textmode) .rc-track').forEach(function (tr) {
      var r = tr.getBoundingClientRect();
      var h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (h > bestArea) { bestArea = h; best = tr; }
    });
    return bestArea > 120 ? best : null;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.defaultPrevented) return;
      // Never steal arrows from text being edited. An EMPTY composer is fair
      // game: chat keeps it focused, and arrows in an empty box do nothing.
      var a = document.activeElement;
      if (a && (a.isContentEditable || a.tagName === 'SELECT')) return;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.value) return;
      var track = activeTrack();
      if (!track) return;
      ev.preventDefault();
      stepDeck(track, ev.key === 'ArrowRight' ? 1 : -1);
    });

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var step = t.closest('[data-rc-step]');
      if (step) {
        stepDeck(step.closest('[data-rc-root]').querySelector('.rc-track'), Number(step.getAttribute('data-rc-step')));
        return;
      }
      var more = t.closest('[data-rc-more]');
      if (more) {
        var cardEl = more.closest('[data-rc-card]');
        var open = cardEl.classList.toggle('rc-open');
        more.textContent = open ? 'Show less' : 'Continue reading';
        return;
      }
      var tog = t.closest('[data-rc-toggle]');
      if (tog) {
        var root = tog.closest('[data-rc-root]');
        var textMode = root.classList.toggle('rc-textmode');
        tog.textContent = textMode ? 'View as cards' : 'Read as text';
      }
    });
  }

  global.ReportCards = { has: isReport, parse: parse, renderToHTML: renderToHTML, render: render };
})(typeof window !== 'undefined' ? window : globalThis);
