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
  var TEXT_REF_RE = /^\s{0,3}\[(\d+)\]:\s+(.+?)\s*$/;
  // "**References**" written as a bold line instead of a heading.
  var BOLD_SOURCES_RE = /^\s*\*\*\s*(sources|references|citations|further reading)\s*:?\s*\*\*\s*:?\s*$/i;
  var WHY_RE = /^\s*(?:[-*]\s*)?\*\*\s*why it matters\s*[:—–-]?\s*\*\*\s*[:—–-]?\s*/i;
  var TAG_RE = /^\s*[*_]*\s*(?:in short|tagline|in a line|one line)\s*[:—–-]\s*(.+?)\s*[*_]*\s*$/i;
  // A sentence where the model narrates its own failed fetch ("the Reuters
  // feed failed to resolve (`getaddrinfo ENOTFOUND`)…"). Plumbing, not news:
  // the whole sentence is dropped from the card.
  var ERROR_SENTENCE_RE = /[^.!?\n]*\b(?:getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b[^.!?\n]*[.!?]?[ \t]*/g;

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
    var lines = String(text || '').replace(/\r\n?/g, '\n').replace(ERROR_SENTENCE_RE, '').split('\n');
    var refs = [];
    var body = [];
    lines.forEach(function (ln) {
      var m = ln.match(REF_DEF_RE);
      // A proper link definition, `[1]: https://… "Title"`.
      if (m && /^(https?:|mailto:|\/)/i.test(m[2])) {
        refs.push({ id: m[1], url: m[2], title: m[3] || '', raw: ln.trim() });
        return;
      }
      // Numbered but not a link — `[3]: Internal stocks API – AAPL $341`. Left
      // in the prose it printed as a stray paragraph in whichever card came
      // last, so list it as a source without a link instead.
      var t = ln.match(TEXT_REF_RE);
      if (t) { refs.push({ id: t[1], url: '', title: t[2], raw: '' }); return; }
      body.push(ln);
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
      // A Sources heading is kept even when empty: its list comes from refs.
      if (hasText || cur.sub || cur.kind === 'sources') slides.push(cur);
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
      if (!inFence && BOLD_SOURCES_RE.test(ln)) { open('sources', 'Sources', 'Sources'); return; }
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
    // Only real link definitions are appended; unlinked sources cite as "(3)".
    var links = refs.filter(function (r) { return r.url; });
    var ids = {};
    links.forEach(function (r) { ids[r.id] = 1; });
    src = src.replace(/(?<!\])\[(\d+)\](?![\[(:])/g, function (m, n) { return ids[n] ? m : n; });
    var full = src + (links.length ? '\n\n' + links.map(function (r) { return r.raw; }).join('\n') : '');
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
          if (!r.url) return '<li><span>' + esc(r.id) + '</span><p>' + esc(r.title) + '</p></li>';
          return '<li><span>' + esc(r.id) + '</span><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
            esc(r.title || hostOf(r.url)) + '<small>' + esc(hostOf(r.url)) + '</small></a></li>';
        }).join('');
        html = kicker('Sources') + '<h3 class="rc-title">' + esc(s.headline === 'Sources' ? 'Where this comes from' : s.headline) + '</h3>' +
          (list ? '<ol class="rc-refs">' + list + '</ol>' : '<div class="rc-body">' + md(s.body, refs) + '</div>') +
          '<div class="rc-tag">Check the claim, not the tone</div>';
        out.push(card(html, i, n, 'rc-sources'));
      } else {
        // The whole story is always shown — a clamped card hid the end of the
        // text. Long ones set a little tighter so they stay card-sized.
        var dense = plainLen(s.body) + plainLen(s.why) > 700;
        html = kicker(s.kicker && s.kicker !== s.headline ? s.kicker : 'Story ' + String(stories.indexOf(s) + 1).padStart(2, '0')) +
          '<h3 class="rc-title">' + esc(s.headline) + '</h3>' +
          (s.sub ? '<p class="rc-sub">' + esc(s.sub) + '</p>' : '') +
          '<div class="rc-body' + (dense ? ' rc-dense' : '') + '">' + md(s.body, refs) + '</div>' +
          (s.why ? '<div class="rc-why"><div class="rc-why-label">Why it matters</div>' + md(s.why, refs) + '</div>' : '') +
          (s.tag ? '<div class="rc-tag">' + esc(s.tag) + '</div>' : '');
        out.push(card(html, i, n, 'rc-story'));
      }
    });

    var plain = md(String(text || '').replace(ERROR_SENTENCE_RE, ''), refs);
    var docName = [d.title || 'Report', d.date].filter(Boolean).join(' - ');
    return '<div class="rc-root" data-rc-root data-rc-name="' + esc(docName) + '">' +
      '<div class="rc-track" tabindex="0" aria-label="' + esc(d.title || 'Report') + ', ' + n + ' cards">' + out.join('') + '</div>' +
      '<div class="rc-bar">' +
        '<button type="button" class="rc-nav" data-rc-step="-1" aria-label="Previous card" title="Previous (&#8592;)">&#8592;</button>' +
        '<button type="button" class="rc-nav" data-rc-step="1" aria-label="Next card" title="Next (&#8594;)">&#8594;</button>' +
        '<span class="rc-hint">' + n + ' cards</span>' +
        '<span class="rc-views" role="group" aria-label="Cards per view">' +
          '<button type="button" class="rc-view" data-rc-view="1" title="One card at a time">1</button>' +
          '<button type="button" class="rc-view" data-rc-view="2" title="Two cards at a time">2</button>' +
        '</span>' +
        '<span class="rc-spacer"></span>' +
        '<button type="button" class="rc-toggle" data-rc-show title="Full-screen slideshow (F). Esc to exit">' +
          'Slideshow <kbd>F</kbd></button>' +
        '<button type="button" class="rc-toggle rc-read-btn" data-rc-reading title="Hide the message box (H), bring it back with C">' +
          '<span class="rc-read-hide">Hide chat <kbd>H</kbd></span><span class="rc-read-show">Show chat <kbd>C</kbd></span></button>' +
        '<button type="button" class="rc-toggle" data-rc-pdf title="Save the deck as a PDF, one card per page">Save as PDF</button>' +
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
    if (hasComposer()) html.classList.add('rc-can-read');
  }

  // ── per-viewer preferences ───────────────────────────────────────
  // Both live as classes on <html>, not on each deck: chat re-inserts cached
  // HTML, so a class on <html> reaches every deck, new or restored.
  var html = typeof document !== 'undefined' ? document.documentElement : null;
  function pref(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* private mode: the default still renders */ }
    return null;
  }

  function cardsPerView(track) {
    if (track.__rcPer) return track.__rcPer;
    var c = track.querySelector('[data-rc-card]');
    if (!c) return 1;
    return Math.max(1, Math.round((track.clientWidth + 14) / (c.getBoundingClientRect().width + 14)));
  }

  function nearestCard(track, cards) {
    var base = cards[0].offsetLeft, idx = 0;
    cards.forEach(function (c, k) {
      if (Math.abs(c.offsetLeft - base - track.scrollLeft) < Math.abs(cards[idx].offsetLeft - base - track.scrollLeft)) idx = k;
    });
    return idx;
  }

  // Step to an exact card rather than scrollBy a width: a second press during
  // the smooth scroll would otherwise land between two cards. Steps a whole
  // view at a time, so two-up turns two cards like pages of a book.
  function stepDeck(track, dir) {
    var cards = track.querySelectorAll('[data-rc-card]');
    if (!cards.length) return;
    var per = cardsPerView(track);
    // Mid-animation, trust the card we are heading to; otherwise the user
    // may have swiped, so find the card nearest the current scroll.
    var target = (track.__rcMoving && track.__rcIdx !== undefined) ? track.__rcIdx : nearestCard(track, cards);
    target = Math.max(0, Math.min(Math.max(0, cards.length - per), target + dir * per));
    track.__rcIdx = target;
    track.__rcMoving = true;
    clearTimeout(track.__rcTimer);
    track.__rcTimer = setTimeout(function () { track.__rcMoving = false; }, 600);
    track.scrollTo({ left: cards[target].offsetLeft - cards[0].offsetLeft, behavior: 'smooth' });
  }

  function setView(n) {
    if (!html) return;
    // Remember where each deck was so switching layout keeps your place.
    var spots = [];
    document.querySelectorAll('[data-rc-root] .rc-track').forEach(function (tr) {
      var cards = tr.querySelectorAll('[data-rc-card]');
      if (cards.length) spots.push([tr, cards, nearestCard(tr, cards)]);
    });
    html.classList.toggle('rc-view-1', n === 1);
    pref('rc_cards_per_view', String(n));
    spots.forEach(function (s) {
      var tr = s[0], cards = s[1], per = cardsPerView(tr);
      var idx = Math.min(s[2], Math.max(0, cards.length - per));
      tr.__rcIdx = idx;
      tr.scrollLeft = cards[idx].offsetLeft - cards[0].offsetLeft;
    });
  }

  // Reading mode hides the chat composer so the deck gets the whole column.
  // Only offered on pages that have one (finchat_chat.html's #composerWrap).
  function hasComposer() { return !!document.getElementById('composerWrap'); }
  function setReading(on) {
    if (!html || (on && !hasComposer())) return;
    html.classList.toggle('rc-reading', on);
    if (!on) {
      var box = document.querySelector('#composerWrap textarea');
      if (box) box.focus();
    } else if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#composerWrap')) {
      document.activeElement.blur();
    }
    var pill = document.getElementById('rcShowChat');
    if (on && !pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'rcShowChat';
      pill.className = 'rc-show-chat';
      pill.setAttribute('data-rc-show-chat', '');
      pill.innerHTML = 'Show chat <kbd>C</kbd>';
      document.body.appendChild(pill);
    }
  }

  // "Save as PDF" is the browser's print-to-PDF on a copy of this one deck:
  // real selectable text, one card per page. The copy sits at the top of
  // <body> and print CSS hides everything else, which sidesteps the chat
  // column's fixed-height scroller clipping the deck. The document title is
  // borrowed for the duration because Chrome names the PDF after it.
  function printDeck(root) {
    var old = document.getElementById('rcPrintHost');
    if (old) old.remove();
    var host = document.createElement('div');
    host.id = 'rcPrintHost';
    var copy = root.cloneNode(true);
    copy.classList.remove('rc-textmode');
    host.appendChild(copy);
    document.body.appendChild(host);
    var title = document.title;
    document.title = root.getAttribute('data-rc-name') || title;
    html.classList.add('rc-printing');
    var done = function () {
      html.classList.remove('rc-printing');
      document.title = title;
      host.remove();
    };
    window.addEventListener('afterprint', done, { once: true });
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(function () { window.print(); });
  }

  // ── slideshow ────────────────────────────────────────────────────
  // A copy of the deck in a full-screen layer, one large card at a time.
  // A copy rather than the deck itself because chat's scrolling column (and
  // its entrance animation) would trap a position:fixed child. Esc, the ×,
  // or leaving browser full screen all close it, and the deck underneath is
  // left on the card the slideshow ended on.
  function showCounter(host) {
    var track = host.querySelector('.rc-track');
    var cards = track.querySelectorAll('[data-rc-card]');
    var el = host.querySelector('[data-rc-show-count]');
    if (el && cards.length) el.textContent = (nearestCard(track, cards) + 1) + ' / ' + cards.length;
  }

  function openShow(root) {
    if (!root || document.getElementById('rcShowHost')) return;
    var src = root.querySelector('.rc-track');
    var srcCards = src.querySelectorAll('[data-rc-card]');
    var start = srcCards.length ? nearestCard(src, srcCards) : 0;

    var host = document.createElement('div');
    host.id = 'rcShowHost';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', (root.getAttribute('data-rc-name') || 'Report') + ' slideshow');
    var copy = root.cloneNode(true);
    copy.classList.remove('rc-textmode');
    copy.querySelector('.rc-bar').remove();
    copy.querySelector('.rc-text').remove();
    copy.insertAdjacentHTML('beforeend',
      '<button type="button" class="rc-show-close" data-rc-show-close aria-label="Close slideshow" title="Close (Esc)">&times;</button>' +
      '<div class="rc-show-bar">' +
        '<button type="button" class="rc-show-nav" data-rc-step="-1" aria-label="Previous card">&#8592;</button>' +
        '<span class="rc-show-count" data-rc-show-count></span>' +
        '<button type="button" class="rc-show-nav" data-rc-step="1" aria-label="Next card">&#8594;</button>' +
        '<span class="rc-show-hint"><kbd>&#8592;</kbd> <kbd>&#8594;</kbd> to move &middot; <kbd>Esc</kbd> to exit</span>' +
      '</div>');
    host.appendChild(copy);
    document.body.appendChild(host);
    html.classList.add('rc-showing');
    host.__rcSrc = src;

    var track = copy.querySelector('.rc-track');
    track.__rcPer = 1;
    var cards = track.querySelectorAll('[data-rc-card]');
    if (cards[start]) track.scrollLeft = cards[start].offsetLeft - cards[0].offsetLeft;
    track.__rcIdx = start;
    track.addEventListener('scroll', function () { showCounter(host); }, { passive: true });
    showCounter(host);
    track.focus({ preventScroll: true });

    if (host.requestFullscreen) host.requestFullscreen().catch(function () { /* layer still covers the window */ });
  }

  function closeShow() {
    var host = document.getElementById('rcShowHost');
    if (!host) return;
    var track = host.querySelector('.rc-track');
    var cards = track.querySelectorAll('[data-rc-card]');
    var idx = cards.length ? nearestCard(track, cards) : 0;
    var src = host.__rcSrc;
    host.remove();
    html.classList.remove('rc-showing');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    if (src && src.isConnected) {
      var srcCards = src.querySelectorAll('[data-rc-card]');
      var i = Math.min(idx, Math.max(0, srcCards.length - cardsPerView(src)));
      if (srcCards[i]) src.scrollLeft = srcCards[i].offsetLeft - srcCards[0].offsetLeft;
      src.__rcIdx = i;
    }
  }

  // The deck the arrow keys drive: the slideshow when it is open, then the
  // one being interacted with, else the one taking up most of the viewport
  // (a chat can hold several briefs).
  function activeTrack() {
    var show = document.getElementById('rcShowHost');
    if (show) return show.querySelector('.rc-track');
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
    if (pref('rc_cards_per_view') === '1') html.classList.add('rc-view-1');

    document.addEventListener('keydown', function (ev) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return;
      var a = document.activeElement;
      var inField = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      var key = ev.key;

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (ev.shiftKey) return;
        // Never steal arrows from text being edited. An EMPTY composer is fair
        // game: chat keeps it focused, and arrows in an empty box do nothing.
        if (inField && (a.tagName === 'SELECT' || a.isContentEditable || a.value)) return;
        var track = activeTrack();
        if (!track) return;
        ev.preventDefault();
        stepDeck(track, key === 'ArrowRight' ? 1 : -1);
        return;
      }

      if (document.getElementById('rcShowHost')) {
        // Browsers keep Esc for leaving full screen and never deliver it
        // here; fullscreenchange closes the slideshow then. This catches Esc
        // when full screen was refused and the layer is only window-sized.
        if (key === 'Escape' || key === 'f' || key === 'F') { ev.preventDefault(); closeShow(); }
        return;
      }

      // H / C / F are letters, so they only count when nothing is being typed.
      if (inField) return;
      if ((key === 'f' || key === 'F') && activeTrack()) {
        ev.preventDefault();
        openShow(activeTrack().closest('[data-rc-root]'));
      } else if ((key === 'h' || key === 'H') && !html.classList.contains('rc-reading') && activeTrack()) {
        ev.preventDefault();
        setReading(true);
      } else if ((key === 'c' || key === 'C') && html.classList.contains('rc-reading')) {
        ev.preventDefault();
        setReading(false);
      }
    });

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var step = t.closest('[data-rc-step]');
      if (step) {
        stepDeck(step.closest('[data-rc-root]').querySelector('.rc-track'), Number(step.getAttribute('data-rc-step')));
        return;
      }
      if (t.closest('[data-rc-show]')) { openShow(t.closest('[data-rc-root]')); return; }
      if (t.closest('[data-rc-show-close]')) { closeShow(); return; }
      var view = t.closest('[data-rc-view]');
      if (view) { setView(Number(view.getAttribute('data-rc-view'))); return; }
      if (t.closest('[data-rc-reading]')) { setReading(!html.classList.contains('rc-reading')); return; }
      if (t.closest('[data-rc-show-chat]')) { setReading(false); return; }
      var pdf = t.closest('[data-rc-pdf]');
      if (pdf) { printDeck(pdf.closest('[data-rc-root]')); return; }
      var tog = t.closest('[data-rc-toggle]');
      if (tog) {
        var root = tog.closest('[data-rc-root]');
        var textMode = root.classList.toggle('rc-textmode');
        tog.textContent = textMode ? 'View as cards' : 'Read as text';
      }
    });

    // Esc in full screen is handled by the browser, which only tells us here.
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) closeShow();
    });
  }

  global.ReportCards = { has: isReport, parse: parse, renderToHTML: renderToHTML, render: render };
})(typeof window !== 'undefined' ? window : globalThis);

