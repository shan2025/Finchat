// board_ui.js — rendering shared by the Boards page and the shared-board page.
//
// Pure markup builders plus one preview helper. Anything that touches the
// network goes through an ADAPTER the page supplies, because the two pages
// reach files differently: the owner through authenticated routes (bytes via
// fetch + blob, never a bare <img src>), a shared reader through the token URL.
//
//   adapter = {
//     blobUrl(att)  → Promise<string>   object/direct URL to show an image or PDF
//     text(att)     → Promise<string>   extracted text of a document or note
//     download(att) → Promise<void>     save the file (or its text)
//   }
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const PRIORITY = {
    high: { label: 'High', color: '#2b59c3' },
    medium: { label: 'Medium', color: '#6631d7' },
    low: { label: 'Low', color: '#12a150' }
  };

  const TAG_COLORS = ['#6631d7', '#2b59c3', '#d62d2d', '#fac710', '#12a150', '#fb8c00',
    '#0ca789', '#e84fa7', '#7a5c3e', '#5f6b7a'];
  const COLUMN_COLORS = ['#fff3a3', '#ffcd9e', '#c6f1d0', '#cde4ff', '#e2d6ff', '#ffd6ea', '#d4f4f1', '#eceff3'];

  /** Dark text on light colours (yellow tags, pastel pills), white elsewhere. */
  function isLight(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
  }
  function dateRange(s, e) {
    if (s && e) return `${fmtDate(s)} – ${fmtDate(e)}`;
    if (s) return `From ${fmtDate(s)}`;
    if (e) return `Due ${fmtDate(e)}`;
    return '';
  }
  const fmtSize = (b) => !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

  /** Icon + colour for an attachment, by what it is. */
  function attIcon(a) {
    if (a.kind === 'link' && a.link) {
      const k = (a.link.kindLabel || '').toLowerCase();
      if (a.link.provider === 'gdoc') {
        if (k.includes('sheet')) return { icon: 'table_chart', color: '#188038' };
        if (k.includes('slides')) return { icon: 'slideshow', color: '#f29900' };
        if (k.includes('form')) return { icon: 'checklist', color: '#7248b9' };
        return { icon: 'description', color: '#1a73e8' };
      }
      return ({
        gdrive: { icon: 'add_to_drive', color: '#0f9d58' },
        youtube: { icon: 'smart_display', color: '#ff0033' },
        image: { icon: 'image', color: '#e84fa7' },
        video: { icon: 'movie', color: '#6631d7' }
      })[a.link.provider] || { icon: 'link', color: '#5f6b7a' };
    }
    if (a.kind === 'text') return { icon: 'sticky_note_2', color: '#e0a800' };
    if (a.kind === 'image' || /^image\//.test(a.mimetype || '')) return { icon: 'image', color: '#e84fa7' };
    if (/pdf/.test(a.mimetype || '')) return { icon: 'picture_as_pdf', color: '#d62d2d' };
    if (/sheet|excel|csv/.test(a.mimetype || '')) return { icon: 'table_chart', color: '#188038' };
    if (/presentation|powerpoint/.test(a.mimetype || '')) return { icon: 'slideshow', color: '#f29900' };
    return { icon: 'draft', color: '#4262ff' };
  }

  function attKindLabel(a) {
    if (a.kind === 'link' && a.link) return a.link.provider === 'web' ? 'Web page' : a.link.kindLabel;
    if (a.kind === 'text') return 'Note';
    if (a.kind === 'image') return 'Image';
    return 'Document';
  }

  const youtubeId = (a) => {
    const m = a.link && /\/embed\/([A-Za-z0-9_-]{11})/.exec(a.link.embedUrl || '');
    return m ? m[1] : null;
  };

  // ── chips ───────────────────────────────────────────────────
  function tagChip(t, { removable = false } = {}) {
    const light = isLight(t.color);
    return `<span class="bx-tag${light ? ' light' : ''}" style="background:${esc(t.color)}" title="${esc(t.label)}">${esc(t.label)}${
      removable ? `<span class="material-symbols-outlined x" data-untag="${esc(t.label)}">close</span>` : ''}</span>`;
  }
  function prioChip(p) {
    const P = PRIORITY[p];
    return P ? `<span class="bx-tag bx-prio" style="background:${P.color}">${P.label}</span>` : '';
  }

  /**
   * One card on the board. `atts` are this card's attachments. The first image
   * or YouTube link becomes a thumbnail, the way Miro shows media on a card;
   * uploaded images are hydrated by the page (data-thumb) since the owner needs
   * an authenticated fetch for them.
   */
  function cardHTML(card, atts = [], { selected = false } = {}) {
    const range = dateRange(card.startDate, card.endDate);
    const chips = [];
    if (range) chips.push(`<span class="bx-date"><span class="material-symbols-outlined">calendar_today</span>${esc(range)}</span>`);
    for (const t of card.tags || []) chips.push(tagChip(t));
    if (card.priority) chips.push(prioChip(card.priority));

    let thumb = '';
    const media = atts.find(a => a.preview === 'image' || a.preview === 'image-link' || youtubeId(a));
    if (media) {
      if (media.preview === 'image-link') {
        thumb = `<img class="bx-thumb" alt="" loading="lazy" referrerpolicy="no-referrer" src="${esc(media.link.href)}">`;
      } else if (youtubeId(media)) {
        thumb = `<img class="bx-thumb" alt="" loading="lazy" referrerpolicy="no-referrer" src="https://i.ytimg.com/vi/${youtubeId(media)}/mqdefault.jpg">`;
      } else {
        thumb = `<img class="bx-thumb" alt="" data-thumb="${esc(media.attachmentId)}">`;
      }
    }

    const shown = atts.slice(0, 3).map(a => {
      const ic = attIcon(a);
      return `<span class="bx-att-chip" title="${esc(a.filename)}"><span class="material-symbols-outlined" style="color:${ic.color}">${ic.icon}</span>${esc(a.filename)}</span>`;
    });
    if (atts.length > 3) shown.push(`<span class="bx-att-chip">+${atts.length - 3} more</span>`);

    return `<div class="bx-card${selected ? ' sel' : ''}" data-card="${esc(card.cardId)}">
      ${card.color ? `<span class="accent" style="background:${esc(card.color)}"></span>` : ''}
      <div class="bx-card-title">${esc(card.title)}</div>
      ${card.summary ? `<div class="bx-card-sum">${esc(card.summary)}</div>` : ''}
      ${thumb}
      ${chips.length ? `<div class="bx-meta">${chips.join('')}</div>` : ''}
      ${shown.length ? `<div class="bx-meta">${shown.join('')}</div>` : ''}
    </div>`;
  }

  /** One attachment row in the card drawer: icon, name, and every action it supports. */
  function attachmentHTML(a, { canRemove = false } = {}) {
    const ic = attIcon(a);
    const sub = [attKindLabel(a), a.kind === 'link' ? (a.link && a.link.host) : fmtSize(a.size),
      a.chars ? a.chars.toLocaleString() + ' chars' : ''].filter(Boolean).join(' · ');
    const acts = [];
    if (a.preview) acts.push(`<button class="bx-btn sm" data-view="${esc(a.attachmentId)}"><span class="material-symbols-outlined">visibility</span>View</button>`);
    if (a.kind === 'link' && a.link) {
      acts.push(`<a class="bx-btn sm" href="${esc(a.link.href)}" target="_blank" rel="noopener noreferrer"><span class="material-symbols-outlined">open_in_new</span>Open</a>`);
    }
    if (a.downloadable) {
      acts.push(`<button class="bx-btn sm" data-download="${esc(a.attachmentId)}"><span class="material-symbols-outlined">download</span>Download${a.hasOriginal ? '' : ' text'}</button>`);
    }
    if (canRemove) acts.push(`<button class="bx-btn sm ghost danger" data-remove="${esc(a.attachmentId)}" title="Remove"><span class="material-symbols-outlined">delete</span></button>`);
    return `<div class="bx-att" data-att="${esc(a.attachmentId)}">
      <div class="bx-att-top">
        <div class="bx-att-ico" style="background:${ic.color}"><span class="material-symbols-outlined">${ic.icon}</span></div>
        <div style="min-width:0; flex:1;">
          <div class="bx-att-name">${esc(a.filename)}</div>
          <div class="bx-att-sub">${esc(sub)}</div>
        </div>
      </div>
      ${acts.length ? `<div class="bx-att-acts">${acts.join('')}</div>` : ''}
    </div>`;
  }

  /**
   * Toggle an attachment's preview inside its row. Returns true when opened.
   * Embeds are sandboxed iframes on named hosts only (the server's CSP
   * frame-src lists exactly YouTube no-cookie, Docs and Drive).
   */
  async function togglePreview(row, a, adapter) {
    const open = row.querySelector('.bx-preview');
    const btn = row.querySelector('[data-view]');
    const label = (on) => { if (btn) btn.innerHTML = `<span class="material-symbols-outlined">${on ? 'visibility_off' : 'visibility'}</span>${on ? 'Hide' : 'View'}`; };
    if (open) { open.remove(); label(false); return false; }
    const box = document.createElement('div');
    box.className = 'bx-preview';
    row.appendChild(box);
    label(true);
    try {
      if (a.preview === 'embed') {
        const f = document.createElement('iframe');
        f.src = a.link.embedUrl;
        f.loading = 'lazy';
        // YouTube refuses to play an embed that sends no referrer (player
        // "Error 153"). Origin only: a URL fragment — where share tokens
        // live — is never part of a referrer anyway.
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        f.allow = 'encrypted-media; picture-in-picture; fullscreen';
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
        f.allowFullscreen = true;
        box.appendChild(f);
        if (a.link.provider !== 'youtube') {
          box.insertAdjacentHTML('beforeend', '<div class="bx-hint">Google shows this only to people the file is shared with. If it stays blank, use Open.</div>');
        }
      } else if (a.preview === 'image-link') {
        box.innerHTML = `<img alt="" referrerpolicy="no-referrer" src="${esc(a.link.href)}">`;
      } else if (a.preview === 'video-link') {
        box.innerHTML = `<video controls preload="metadata" src="${esc(a.link.href)}"></video>`;
      } else if (a.preview === 'image') {
        box.textContent = 'Loading…';
        const url = await adapter.blobUrl(a);
        box.innerHTML = `<img alt="${esc(a.filename)}" src="${esc(url)}">`;
      } else if (a.preview === 'pdf') {
        box.remove(); label(false);
        // The tab opens BEFORE the await: opened after it, the popup blocker
        // treats it as unsolicited and swallows it.
        const tab = window.open('about:blank', '_blank');
        try {
          const url = await adapter.blobUrl(a);
          if (tab) tab.location = url; else window.open(url, '_blank');
        } catch (e) {
          if (tab) tab.close();
          throw e;
        }
        return false;
      } else {
        box.innerHTML = '<pre>Loading…</pre>';
        const text = await adapter.text(a);
        box.firstChild.textContent = text || '(no text)';
      }
    } catch (e) {
      box.innerHTML = `<div class="bx-hint">Could not load: ${esc(e.message)}</div>`;
    }
    return true;
  }

  function toast(msg) {
    let t = document.getElementById('bxToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'bxToast';
      t.className = 'bx-toast';
      (document.querySelector('.bx') || document.body).appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3000);
  }

  /** Save a Response's body under the name its Content-Disposition gives. */
  async function saveResponse(res, fallback) {
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `the server answered ${res.status}`);
    }
    const cd = res.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/i.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : fallback);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return a.download;
  }

  // ── an image to build a board from ─────────────────────────
  // Click, paste (Ctrl+V anywhere in `pasteRoot`) or drop. Big photos are
  // scaled down in the browser first: a 12 MP phone shot is ~5 MB of pixels
  // the vision model does not need, and the server caps uploads at 8 MB.
  const PLAN_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  async function shrinkImage(file) {
    if (file.size <= 3.5 * 1024 * 1024 || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
      return blob ? new File([blob], (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (e) {
      return file;
    }
  }

  // Documents the board builder can read — the same set chat attachments
  // extract (services/attachments.js). Spreadsheets and slides are not in it.
  const PLAN_DOC_EXTS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.json'];
  const PLAN_FILES_MAX = 5;
  const extOf = (name) => (String(name || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const isImage = (f) => PLAN_IMAGE_TYPES.includes(f.type);

  /**
   * Files to build a board from: images (a whiteboard photo, a screenshot) and
   * documents (a PDF brief, a Word spec, notes). Click, drop, or paste an image.
   */
  function planFilesPicker(host, { pasteRoot = host, onChange } = {}) {
    let files = [];   // [{file, url}] — url only for images (the thumbnail)
    host.classList.add('bx-imgpick');
    host.innerHTML = `
      <div class="bx-imgpick-list"></div>
      <button type="button" class="bx-imgpick-zone">
        <span class="material-symbols-outlined">upload_file</span>
        <span><b>Add files</b> — click, drop, or paste an image (Ctrl+V).
          <small>Images, PDF, Word (.docx), text, Markdown or CSV · up to ${PLAN_FILES_MAX}. A whiteboard photo, a brief, meeting notes, a spec.</small></span>
      </button>
      <input type="file" multiple accept="${[...PLAN_IMAGE_TYPES, ...PLAN_DOC_EXTS].join(',')}" hidden>`;
    const list = host.querySelector('.bx-imgpick-list');
    const zone = host.querySelector('.bx-imgpick-zone');
    const input = host.querySelector('input');

    function paint() {
      list.innerHTML = files.map((x, i) => {
        const ic = isImage(x.file) ? null : attIcon({ kind: 'document', filename: x.file.name, mimetype: x.file.type });
        return `<div class="bx-imgpick-prev">
          ${x.url ? `<img alt="" src="${esc(x.url)}">`
            : `<span class="bx-att-ico" style="background:${ic.color}; width:44px; height:44px;"><span class="material-symbols-outlined">${ic.icon}</span></span>`}
          <div class="bx-imgpick-meta"><b>${esc(x.file.name || 'Pasted image')}</b><small>${fmtSize(x.file.size)}</small></div>
          <button type="button" class="bx-ibtn" data-remove="${i}" title="Remove"><span class="material-symbols-outlined">close</span></button>
        </div>`;
      }).join('');
      zone.hidden = files.length >= PLAN_FILES_MAX;
      if (onChange) onChange(files.map(x => x.file));
    }
    async function add(fileList) {
      for (const f of [...(fileList || [])]) {
        if (files.length >= PLAN_FILES_MAX) { toast(`At most ${PLAN_FILES_MAX} files`); break; }
        if (isImage(f)) {
          const small = await shrinkImage(f);
          if (small.size > 8 * 1024 * 1024) { toast(`${f.name} is over 8 MB — use a smaller image`); continue; }
          files.push({ file: small, url: URL.createObjectURL(small) });
        } else if (PLAN_DOC_EXTS.includes(extOf(f.name))) {
          if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`); continue; }
          files.push({ file: f, url: null });
        } else {
          toast(`${f.name || 'That file'}: use an image, PDF, Word (.docx), text, Markdown or CSV`);
        }
      }
      paint();
    }
    function clear() {
      files.forEach(x => x.url && URL.revokeObjectURL(x.url));
      files = []; input.value = '';
      paint();
    }

    zone.addEventListener('click', () => input.click());
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      const [gone] = files.splice(Number(b.dataset.remove), 1);
      if (gone && gone.url) URL.revokeObjectURL(gone.url);
      paint();
    });
    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    host.addEventListener('dragover', (e) => { e.preventDefault(); host.classList.add('drag'); });
    host.addEventListener('dragleave', () => host.classList.remove('drag'));
    host.addEventListener('drop', (e) => {
      e.preventDefault();
      host.classList.remove('drag');
      add(e.dataTransfer && e.dataTransfer.files);
    });
    // Only FILES on the clipboard are taken; pasted text still lands in the textarea.
    pasteRoot.addEventListener('paste', (e) => {
      const got = [...((e.clipboardData && e.clipboardData.items) || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (!got.length) return;
      e.preventDefault();
      add(got);
    });
    paint();
    return { get files() { return files.map(x => x.file); }, add, clear };
  }

  window.BoardUI = {
    esc, isLight, fmtDate, dateRange, fmtSize, attIcon, tagChip, prioChip, cardHTML, attachmentHTML,
    togglePreview, toast, saveResponse, planFilesPicker, PRIORITY, TAG_COLORS, COLUMN_COLORS, youtubeId
  };
})();
