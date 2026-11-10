// Colours for the light chart surface. Categorical slots come from a palette validated
// against it (validate_palette.js --mode light); status colours are reserved for state, never for series.
export const THEME = {
  surface: '#fcfcfb',
  surface2: '#f4f3ef',
  line: '#dcdad2',
  text1: '#1a1a19',
  text2: '#4a4943',
  muted: '#6f6e67',
  neutral: '#8c8b84',
  // categorical, fixed order, never cycled: communities beyond the 7th fold into neutral
  cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
  status: { reported: '#ec835a', in_progress: '#fab219', finished: '#0ca30c' },
  edge: 'rgba(40,40,35,0.22)',
  edgeHi: 'rgba(26,26,25,0.88)',
  select: '#1a1a19',
  match: '#d99200',
  path: '#d98200',
};

export const fmtDate = (ms) =>
  ms == null || Number.isNaN(ms) ? '—' : new Date(ms).toISOString().slice(0, 10);
export const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
export const pretty = (s) => String(s).replace(/_/g, ' ');
