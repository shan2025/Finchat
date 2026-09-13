// Shared pieces of the Tailwind config for FinChat.
//
// Every page used to carry its own inline `tailwind.config` next to the
// cdn.tailwindcss.com script, which compiled CSS in the browser on each of the
// 17 pages. The union of those configs lives here instead, so the CSS is built
// once at deploy time.
//
// The audit page is deliberately NOT part of the main palette: it reuses the
// same token names (primary, background, surface, outline, …) for a dark teal
// scheme, so merging it would repaint it in cream. See tailwind.audit.config.js.

// Anchored to this file, not the working directory — `npm run build:css` runs
// from ../backend, where a relative glob would scan the wrong tree and emit an
// empty stylesheet. Forward slashes because fast-glob treats "\" as an escape.
const path = require('path');
const here = (p) => path.join(__dirname, p).replace(/\\/g, '/');

const CONTENT = [here('*.html'), here('*.js')];

// Tailwind and its plugins are devDependencies of ../backend (the only
// package.json in the tree), but these configs live beside the HTML they
// describe, so plain require() cannot always walk up to them.
//
// Two layouts have to work: the repo (frontend/ next to backend/) and the
// Docker image, where the frontend is copied to /frontend while node_modules
// lives at /app/node_modules — not an ancestor, so relative resolution fails.
// The Dockerfile sets NODE_PATH for that case, which plain require() honours.
const fromBackend = (pkg) => {
  const candidates = [pkg, path.join(__dirname, '..', 'backend', 'node_modules', pkg)];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (e) { /* try the next layout */ }
  }
  throw new Error(
    `Cannot resolve Tailwind plugin "${pkg}". Install devDependencies in ` +
    `legacy_prototype/backend, or set NODE_PATH to its node_modules.`
  );
};

const PLUGINS = [
  fromBackend('@tailwindcss/forms'),
  fromBackend('@tailwindcss/container-queries'),
];

// RGB-channel tokens so Tailwind's `/50` opacity modifier works against the
// CSS custom properties defined in finchat_theme.css.
const THEME_TOKENS = {
  'primary-brown': 'rgb(var(--chrome-rgb) / <alpha-value>)',
  'cream-bg': 'rgb(var(--bg-rgb) / <alpha-value>)',
  'cream-card': 'rgb(var(--surface-rgb) / <alpha-value>)',
  'cream-card-hover': 'rgb(var(--surface-2-rgb) / <alpha-value>)',
  'accent-gold': 'rgb(var(--gold-rgb) / <alpha-value>)',
  'text-primary': 'rgb(var(--text-rgb) / <alpha-value>)',
  'text-secondary': 'rgb(var(--text-2-rgb) / <alpha-value>)',
};

// Resolve through the finchat_theme.css stacks, so a Tailwind `font-serif` is
// the same face as `var(--serif)`. These used to name Inter and Playfair
// Display — Playfair is never loaded, so `font-serif` rendered Times New Roman.
const SANS = ['var(--sans)'];
const SERIF = ['var(--serif)'];
const MONO = ['var(--mono)'];

const FONT_FAMILY = {
  'headline-lg': SANS,
  'headline-md': SANS,
  'headline-xl': SANS,
  'body-lg': SANS,
  'body-md': SANS,
  'body-sm': SANS,
  'code-md': MONO,
  'code-sm': MONO,
  'label-caps': SANS,
  serif: SERIF,
  sans: SANS,
  headline: SANS,
  display: SANS,
  body: SANS,
  label: SANS,
  mono: MONO,
};

const FONT_SIZE = {
  'headline-xl': ['48px', { lineHeight: '56px', letterSpacing: '-0.04em', fontWeight: '700' }],
  'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '600' }],
  'headline-md': ['24px', { lineHeight: '32px', letterSpacing: '-0.01em', fontWeight: '600' }],
  'body-lg': ['18px', { lineHeight: '28px', letterSpacing: '0em', fontWeight: '400' }],
  'body-md': ['16px', { lineHeight: '24px', letterSpacing: '0em', fontWeight: '400' }],
  'label-md': ['14px', { lineHeight: '20px', letterSpacing: '0.01em', fontWeight: '500' }],
  'label-sm': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
};

const BORDER_RADIUS = {
  DEFAULT: '1rem',
  lg: '2rem',
  xl: '3rem',
  full: '9999px',
};

const SPACING = {
  unit: '4px',
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '40px',
  gutter: '20px',
  'margin-mobile': '16px',
  'margin-desktop': '64px',
};

// `h-screen` is 100vh, which mobile browsers size as if their URL bar were
// collapsed and never shrink for the on-screen keyboard — so a pinned layout
// pushes its bottom edge (the chat composer) out of reach. dvh tracks what is
// actually visible; the 100vh entry is the fallback for browsers without it.
const VIEWPORT_HEIGHT = { screen: ['100vh', '100dvh'] };

module.exports = {
  here,
  VIEWPORT_HEIGHT,
  CONTENT,
  PLUGINS,
  THEME_TOKENS,
  FONT_FAMILY,
  FONT_SIZE,
  BORDER_RADIUS,
  SPACING,
};
