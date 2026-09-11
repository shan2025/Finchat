/* avatar_image.js — one place that knows what a profile photo is.
 *
 * Two rules live here, and they are the whole file:
 *
 *  1. What we SEND. A picked photo is cropped to a centred square and resized
 *     to 256px in the browser before upload. The first version of this feature
 *     posted the raw file as a base64 data: URL — one account ended up with a
 *     3.3MB string in its `users` row, which /api/auth/me then returned on
 *     every page load of every page. Resizing here is what keeps a profile
 *     photo a ~20KB thing.
 *
 *  2. What we SHOW. An uploaded photo is served by GET /api/auth/avatar/:id,
 *     which is behind requireAuth — so its URL cannot go straight into an
 *     <img src>; it is fetched with the session token and shown as a blob, the
 *     same way chat attachments are. A Google sign-in picture is an ordinary
 *     https URL and passes through untouched, as does a legacy data: URL that
 *     has not been migrated yet.
 */
(function () {
  'use strict';

  var AUTH_PATH = '/api/auth/avatar/';
  var SIZE = 256;
  var QUALITY = 0.85;
  var blobs = {};   // avatar_url → object URL, so a re-render is free

  function apiBase() {
    return location.protocol.indexOf('http') === 0 ? location.origin : 'http://localhost:3000';
  }

  function sessionToken() {
    try {
      return localStorage.getItem('finchat_token') || sessionStorage.getItem('finchat_token') || '';
    } catch (e) { return ''; }
  }

  // → Promise of something you can put in an <img src>, or '' if there is no
  // photo to show. Never rejects: a broken photo falls back to initials.
  function src(url, token) {
    if (!url) return Promise.resolve('');
    if (url.indexOf(AUTH_PATH) !== 0) return Promise.resolve(url);
    if (blobs[url]) return Promise.resolve(blobs[url]);
    var t = token || sessionToken();
    if (!t) return Promise.resolve('');
    return fetch(apiBase() + url, { headers: { 'Authorization': 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) {
        if (!b) return '';
        blobs[url] = URL.createObjectURL(b);
        return blobs[url];
      })
      .catch(function () { return ''; });
  }

  // Fill an element with the photo, or with `fallbackHtml` when there is none
  // (initials, usually). `extraHtml` rides along inside the element — the chat
  // sidebar hangs a presence dot off its avatar.
  function paint(el, url, opts) {
    if (!el) return Promise.resolve(false);
    var o = opts || {};
    return src(url, o.token).then(function (resolved) {
      if (!resolved) {
        if (o.fallbackHtml != null) el.innerHTML = o.fallbackHtml;
        else if (o.fallbackText != null) el.textContent = o.fallbackText;
        return false;
      }
      el.innerHTML = '<img src="' + resolved + '" alt="" referrerpolicy="no-referrer" ' +
        'style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' + (o.extraHtml || '');
      return true;
    });
  }

  // → Promise of a small square data: URL ready to POST as `avatarUrl`.
  function prepare(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('No file chosen'));
      if (!/^image\//.test(file.type)) return reject(new Error('That file is not an image'));
      var img = new Image();
      var objUrl = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(objUrl);
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return reject(new Error('Could not read that image'));
        var c = document.createElement('canvas');
        c.width = c.height = SIZE;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
          side, side, 0, 0, SIZE, SIZE);
        // Older Safari has no WebP encoder and hands back a PNG without saying
        // so — three times the size for no gain, so check rather than assume.
        var out = c.toDataURL('image/webp', QUALITY);
        if (out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/jpeg', QUALITY);
        resolve(out);
      };
      // HEIC lands here: Chrome cannot decode it, so say what to do instead.
      img.onerror = function () {
        URL.revokeObjectURL(objUrl);
        reject(new Error('Could not read that image — try a JPEG, PNG or WebP'));
      };
      img.src = objUrl;
    });
  }

  window.fcAvatar = { src: src, paint: paint, prepare: prepare, SIZE: SIZE, AUTH_PATH: AUTH_PATH };
})();
