// Main FinChat stylesheet config — the cream/brown identity used by every page
// except the audit console. Builds to finchat_tw.css.
const s = require('./tailwind.shared');

module.exports = {
  content: s.CONTENT,
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ...s.THEME_TOKENS,

        // Cream/brown palette. #4a3828 and #2a241d are the product identity —
        // do not drift these without a design decision.
        primary: '#3a2e23',
        'primary-container': '#efe8de',
        'primary-fixed': '#efe8de',
        'primary-fixed-dim': '#c9c7b7',
        'on-primary': '#ffffff',
        'on-primary-container': '#3a2e23',
        'on-primary-fixed': '#1c1c12',
        'on-primary-fixed-variant': '#48473b',
        'inverse-primary': '#efe8de',

        secondary: '#8c7a6b',
        'secondary-container': '#e8dfd1',
        'secondary-fixed': '#e6e2da',
        'secondary-fixed-dim': '#c9c6bf',
        'on-secondary': '#31312b',
        'on-secondary-container': '#3a2e23',
        'on-secondary-fixed': '#1c1c17',
        'on-secondary-fixed-variant': '#484741',

        tertiary: '#cfc4cd',
        'tertiary-container': '#b3a9b2',
        'tertiary-fixed': '#ebdfe9',
        'tertiary-fixed-dim': '#cec3cd',
        'on-tertiary': '#352e35',
        'on-tertiary-container': '#453e45',
        'on-tertiary-fixed': '#1f1a20',
        'on-tertiary-fixed-variant': '#4c444c',

        background: '#f7f4ed',
        'on-background': '#3a2e23',
        surface: '#efe8de',
        'surface-bright': '#5c4a38',
        'surface-dim': '#e8dfd1',
        'surface-variant': '#e8dfd1',
        'surface-tint': '#c9c7b7',
        'surface-container': '#f3eee3',
        'surface-container-low': '#efe8de',
        'surface-container-lowest': '#ffffff',
        'surface-container-high': '#e8dfd1',
        'surface-container-highest': '#4a3828',
        'on-surface': '#3a2e23',
        'on-surface-variant': '#8c7a6b',
        'inverse-surface': '#3a2e23',
        'inverse-on-surface': '#f7f4ed',

        outline: '#8c7a6b',
        'outline-variant': '#d6ccbc',
        'border-color': '#E5DEC5',

        error: '#dc2626',
        'error-container': '#fca5a5',
        'on-error': '#ffffff',
        'on-error-container': '#7f1d1d',

        // Auth + wallet pages use their own names, which do not collide.
        beige: '#f6f3eb',
        darkBrown: '#3a2b1c',
        textMuted: '#6B7280',
        borderLight: '#e0e0e0',
      },
      fontFamily: s.FONT_FAMILY,
      fontSize: s.FONT_SIZE,
      borderRadius: s.BORDER_RADIUS,
      spacing: s.SPACING,
    },
  },
  plugins: s.PLUGINS,
};
