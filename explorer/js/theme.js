// Colours for the dark chart surface. Categorical slots come from a validated
// palette (dark-mode steps); status colours are reserved for state, never for series.
export const THEME = {
  surface: '#1a1a19',
  surface2: '#242422',
  line: '#383835',
  text1: '#f0efec',
  text2: '#c3c2b7',
  muted: '#8e8d86',
  neutral: '#7d7c76',
  // categorical, fixed order, never cycled: communities beyond the 7th fold into neutral
  cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
  status: { reported: '#ec835a', in_progress: '#fab219', finished: '#0ca30c' },
  edge: 'rgba(195,194,183,0.20)',
  edgeHi: 'rgba(240,239,236,0.92)',
  select: '#f0efec',
  match: '#fab219',
  path: '#fab219',
};

export const fmtDate = (ms) =>
  ms == null || Number.isNaN(ms) ? '—' : new Date(ms).toISOString().slice(0, 10);
export const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
export const pretty = (s) => String(s).replace(/_/g, ' ');
