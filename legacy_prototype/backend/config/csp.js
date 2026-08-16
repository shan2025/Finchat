// config/csp.js — the Content-Security-Policy directives the app serves.
//
// Lives in its own module so test/csp-inline-handlers.test.js can render the
// real header through helmet and assert on it, rather than trusting a comment.
//
// The one directive worth understanding before editing: helmet's defaults set
// `script-src-attr 'none'`, and that is a *separate* directive from
// `script-src` — 'unsafe-inline' in script-src does not cover inline on*=
// attributes. Adding the CSP without overriding script-src-attr took every
// button in the UI offline at once (220 inline handlers across 17 pages) while
// inline <script> blocks kept running, so nothing looked broken.
module.exports = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  // Inline event-handler attributes. Has to stay until the handlers move to
  // addEventListener; it grants nothing that script-src 'unsafe-inline'
  // above does not already allow.
  scriptSrcAttr: ["'unsafe-inline'"],
  // jsdelivr is not listed in style-src: the only things still loaded from it
  // are marked and DOMPurify, which are scripts.
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"]
};
