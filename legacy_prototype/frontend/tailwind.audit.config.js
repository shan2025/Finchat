// Audit console only. It reuses the standard token names (primary, background,
// surface, outline, error, …) for a dark teal scheme, so it cannot share the
// cream stylesheet — the names collide with different values. Builds to
// finchat_tw_audit.css, and only finchat_audit.html links it.
const s = require('./tailwind.shared');

module.exports = {
  content: ['finchat_audit.html', 'sidebar_nav.js', 'sidebar_collapse.js',
    'notifications_widget.js', 'knowledge_search.js', 'system_panels.js']
    .map(s.here),
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ...s.THEME_TOKENS,
        'border-color': '#E5DEC5',

        primary: '#ffffff',
        'primary-container': '#5ffbd6',
        'primary-fixed': '#5ffbd6',
        'primary-fixed-dim': '#38debb',
        'on-primary': '#00382d',
        'on-primary-container': '#00725e',
        'on-primary-fixed': '#002019',
        'on-primary-fixed-variant': '#005142',
        'inverse-primary': '#006b58',

        secondary: '#bcc6e6',
        'secondary-container': '#3c4661',
        'secondary-fixed': '#d9e2ff',
        'secondary-fixed-dim': '#bcc6e6',
        'on-secondary': '#263049',
        'on-secondary-container': '#aab4d4',
        'on-secondary-fixed': '#101b33',
        'on-secondary-fixed-variant': '#3c4661',

        tertiary: '#ffffff',
        'tertiary-container': '#fbe273',
        'tertiary-fixed': '#fbe273',
        'tertiary-fixed-dim': '#dec65a',
        'on-tertiary': '#393000',
        'on-tertiary-container': '#756400',
        'on-tertiary-fixed': '#211b00',
        'on-tertiary-fixed-variant': '#534600',

        background: '#0e1512',
        'on-background': '#dde4e0',
        surface: '#0e1512',
        'surface-bright': '#333b38',
        'surface-dim': '#0e1512',
        'surface-variant': '#2f3633',
        'surface-tint': '#38debb',
        'surface-container': '#1a211f',
        'surface-container-low': '#161d1b',
        'surface-container-lowest': '#09100d',
        'surface-container-high': '#242c29',
        'surface-container-highest': '#2f3633',
        'on-surface': '#dde4e0',
        'on-surface-variant': '#bacac3',
        'inverse-surface': '#dde4e0',
        'inverse-on-surface': '#2b322f',

        outline: '#85948e',
        'outline-variant': '#3c4a45',

        error: '#ffb4ab',
        'error-container': '#93000a',
        'on-error': '#690005',
        'on-error-container': '#ffdad6',
      },
      fontFamily: s.FONT_FAMILY,
      fontSize: s.FONT_SIZE,
      borderRadius: s.BORDER_RADIUS,
      spacing: s.SPACING,
    },
  },
  plugins: s.PLUGINS,
};
