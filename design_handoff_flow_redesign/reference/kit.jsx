// kit.jsx — shared design system for the Privacy Screen redesign.
// Injects one global stylesheet (ps- prefixed) and exports themed primitives,
// an accessible token system, and a small stroke-icon set to window.
// Both themes are tuned to WCAG AA (4.5:1 body text, 3:1 UI/large).

(function injectKit() {
  if (document.getElementById('ps-kit')) return;
  const css = `
  .ps-root{
    font-family:'IBM Plex Sans',system-ui,sans-serif;
    color:var(--text); background:var(--bg);
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    height:100%; width:100%; box-sizing:border-box; position:relative;
    --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  }
  .ps-root *{box-sizing:border-box;}
  .ps-mono{font-family:var(--mono);font-feature-settings:'zero' 1;}

  /* ── Dark theme (default) — cool near-black ── */
  .ps-dark{
    --bg:#0d1117; --surface:#151b23; --surface-2:#1b232e; --surface-3:#212b38;
    --border:#283140; --border-2:#374150; --hairline:rgba(255,255,255,.06);
    --text:#e9eef5; --text-dim:#aeb9c6; --text-faint:#7e8b9a;
    --shadow:0 1px 0 rgba(255,255,255,.03) inset, 0 8px 24px rgba(0,0,0,.4);
    --ok:#3fb950; --ok-tint:rgba(63,185,80,.14);
    --warn:#e3a008; --warn-tint:rgba(227,160,8,.14);
    --danger:#f76d6d; --danger-bg:#2a1517; --danger-border:#69262a;
  }
  /* ── Light theme — soft cool paper ── */
  .ps-light{
    --bg:#f4f6f9; --surface:#ffffff; --surface-2:#f1f4f8; --surface-3:#e9edf3;
    --border:#dde3ea; --border-2:#c8d1db; --hairline:rgba(15,23,32,.07);
    --text:#161c24; --text-dim:#4d5763; --text-faint:#6e7986;
    --shadow:0 1px 2px rgba(15,23,32,.06), 0 8px 22px rgba(15,23,32,.06);
    --ok:#1a7f37; --ok-tint:rgba(26,127,55,.10);
    --warn:#9a6700; --warn-tint:rgba(154,103,0,.10);
    --danger:#c4393f; --danger-bg:#fdeced; --danger-border:#f3c2c4;
  }

  /* ── Accent per direction, theme-aware for contrast ── */
  .ps-dark.ps-acc-console,.ps-dark .ps-acc-console{--acc:#4c8dff;--acc-2:#6ba2ff;--acc-ink:#06122a;--acc-tint:rgba(76,141,255,.16);--acc-line:rgba(76,141,255,.45);}
  .ps-light.ps-acc-console,.ps-light .ps-acc-console{--acc:#1f6feb;--acc-2:#1a5fce;--acc-ink:#ffffff;--acc-tint:rgba(31,111,235,.10);--acc-line:rgba(31,111,235,.40);}
  .ps-dark.ps-acc-flow,.ps-dark .ps-acc-flow{--acc:#37d39a;--acc-2:#54e0ad;--acc-ink:#04201a;--acc-tint:rgba(55,211,154,.15);--acc-line:rgba(55,211,154,.42);}
  .ps-light.ps-acc-flow,.ps-light .ps-acc-flow{--acc:#0a8f5f;--acc-2:#0b7d54;--acc-ink:#ffffff;--acc-tint:rgba(10,143,95,.10);--acc-line:rgba(10,143,95,.38);}
  .ps-dark.ps-acc-chat,.ps-dark .ps-acc-chat{--acc:#b08bff;--acc-2:#c2a4ff;--acc-ink:#170a2e;--acc-tint:rgba(176,139,255,.16);--acc-line:rgba(176,139,255,.45);}
  .ps-light.ps-acc-chat,.ps-light .ps-acc-chat{--acc:#6d3fd6;--acc-2:#5d33bd;--acc-ink:#ffffff;--acc-tint:rgba(109,63,214,.10);--acc-line:rgba(109,63,214,.40);}

  /* layout helpers */
  .ps-row{display:flex;align-items:center;}
  .ps-col{display:flex;flex-direction:column;}
  .ps-grow{flex:1 1 auto;min-width:0;min-height:0;}
  .ps-gap2{gap:2px;} .ps-gap4{gap:4px;} .ps-gap6{gap:6px;} .ps-gap8{gap:8px;}
  .ps-gap10{gap:10px;} .ps-gap12{gap:12px;} .ps-gap16{gap:16px;} .ps-gap20{gap:20px;} .ps-gap24{gap:24px;}

  /* surfaces */
  .ps-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;}
  .ps-inset{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;}

  /* type */
  .ps-eyebrow{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-faint);}
  .ps-h{font-weight:600;letter-spacing:-.01em;color:var(--text);}
  .ps-dim{color:var(--text-dim);} .ps-faint{color:var(--text-faint);}

  /* buttons — min 36px height, visible focus */
  .ps-btn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border-radius:9px;
    font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent;
    transition:background .14s,border-color .14s,color .14s;white-space:nowrap;}
  .ps-btn-primary{background:var(--acc);color:var(--acc-ink);}
  .ps-btn-primary:hover{background:var(--acc-2);}
  .ps-btn-ghost{background:transparent;border-color:var(--border-2);color:var(--text-dim);}
  .ps-btn-ghost:hover{background:var(--surface-2);color:var(--text);}
  .ps-btn-soft{background:var(--surface-2);border-color:var(--border);color:var(--text);}
  .ps-btn-soft:hover{background:var(--surface-3);}
  .ps-btn-danger{background:transparent;border-color:var(--danger-border);color:var(--danger);}
  .ps-btn-sm{height:30px;padding:0 10px;font-size:12px;border-radius:8px;}
  .ps-btn:disabled{opacity:.45;cursor:not-allowed;}
  *:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px;}

  /* badges + status */
  .ps-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;
    font-size:11px;font-weight:600;letter-spacing:.02em;background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border);white-space:nowrap;}
  .ps-dot{width:7px;height:7px;border-radius:50%;flex:none;}
  .ps-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;font-size:12px;
    font-weight:500;background:var(--surface-2);border:1px solid var(--border);color:var(--text-dim);white-space:nowrap;}

  /* inputs */
  .ps-input,.ps-textarea{width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;
    color:var(--text);font:inherit;font-size:13px;padding:10px 12px;}
  .ps-input::placeholder,.ps-textarea::placeholder{color:var(--text-faint);}
  .ps-textarea{resize:none;line-height:1.6;}
  .ps-search{display:flex;align-items:center;gap:8px;height:36px;padding:0 11px;background:var(--surface-2);
    border:1px solid var(--border);border-radius:9px;color:var(--text-faint);font-size:13px;}

  /* segmented control */
  .ps-seg{display:inline-flex;padding:3px;background:var(--surface-2);border:1px solid var(--border);border-radius:9px;gap:2px;}
  .ps-seg button{height:28px;padding:0 12px;border:0;background:transparent;color:var(--text-faint);font:inherit;
    font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
  .ps-seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow);}

  /* toggle */
  .ps-toggle{width:38px;height:22px;border-radius:11px;background:var(--border-2);position:relative;flex:none;transition:background .16s;cursor:pointer;border:0;}
  .ps-toggle[aria-checked="true"]{background:var(--acc);}
  .ps-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.3);}
  .ps-toggle[aria-checked="true"]::after{transform:translateX(16px);}

  /* nav rail */
  .ps-rail-item{display:flex;flex-direction:column;align-items:center;gap:5px;width:100%;padding:11px 0;border-radius:11px;
    color:var(--text-faint);cursor:pointer;border:0;background:transparent;font:inherit;font-size:10px;font-weight:600;letter-spacing:.02em;position:relative;}
  .ps-rail-item:hover{color:var(--text-dim);background:var(--surface-2);}
  .ps-rail-item[aria-current="page"]{color:var(--acc);background:var(--acc-tint);}
  .ps-rail-item[aria-current="page"]::before{content:'';position:absolute;left:-9px;top:50%;transform:translateY(-50%);width:3px;height:22px;border-radius:2px;background:var(--acc);}

  /* token pill — category named in the token text itself (not color-only) */
  .ps-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 7px 1px 6px;border-radius:6px;
    font-family:var(--mono);font-size:.86em;font-weight:500;white-space:nowrap;border:1px solid;vertical-align:baseline;
    background:color-mix(in srgb, var(--cat) 17%, transparent);
    border-color:color-mix(in srgb, var(--cat) 42%, transparent);}
  .ps-dark .ps-pill{color:color-mix(in srgb, var(--cat) 62%, #ffffff);}
  .ps-light .ps-pill{color:color-mix(in srgb, var(--cat) 64%, #000000);}
  .ps-pill .ps-pilldot{width:6px;height:6px;border-radius:2px;background:var(--cat);flex:none;}

  /* list row */
  .ps-rowitem{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);}

  /* scrollbars hidden by canvas; keep content tidy */
  .ps-scroll::-webkit-scrollbar{width:8px;height:8px;}
  .ps-scroll::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:8px;}

  .ps-divider{height:1px;background:var(--border);width:100%;}
  .ps-vdiv{width:1px;background:var(--border);align-self:stretch;}
  `;
  const el = document.createElement('style');
  el.id = 'ps-kit';
  el.textContent = css;
  document.head.appendChild(el);
})();

// ── Category metadata ────────────────────────────────────────
const CATS = {
  ip:        { color: '#4c8dff', label: 'IP' },
  customer:  { color: '#b07cff', label: 'Customer' },
  email:     { color: '#26c281', label: 'Email' },
  host:      { color: '#22c1d6', label: 'Hostname' },
  phone:     { color: '#f59e0b', label: 'Phone' },
  addr:      { color: '#fb923c', label: 'Address' },
  url:       { color: '#2dd4bf', label: 'URL' },
  account:   { color: '#fb7185', label: 'Account' },
  user:      { color: '#f0a5c0', label: 'User' },
  path:      { color: '#94a3b8', label: 'Path' },
  credential:{ color: '#f76d6d', label: 'Credential' },
};

// Token pill: the {TOKEN} text already names its category, so color is
// redundant reinforcement — never the sole signal (WCAG 1.4.1).
function Pill({ cat = 'ip', children, dot = false }) {
  const c = CATS[cat] || CATS.ip;
  return (
    <span className="ps-pill" style={{ '--cat': c.color }}>
      {dot && <span className="ps-pilldot" />}
      {children}
    </span>
  );
}

// ── Stroke icons (simple, lucide-ish, 24 grid) ───────────────
const ICON = {
  shield: 'M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  eye: 'M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z|M12 12m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0',
  eyeoff: 'M3 3l18 18|M10.6 6.2A9.7 9.7 0 0 1 12 6.1c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.2 7.3A17 17 0 0 0 2 12s3.5 6.5 10 6.5a9.6 9.6 0 0 0 3.5-.65',
  check: 'M4 12.5l5 5 11-11',
  x: 'M5 5l14 14M19 5L5 19',
  alert: 'M12 4l9 16H3zM12 10v5M12 18h.01',
  settings: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z|M19.4 13a7.7 7.7 0 0 0 0-2l1.8-1.4-2-3.4L19 7a7.6 7.6 0 0 0-1.7-1l-.3-2.2H11l-.3 2.2A7.6 7.6 0 0 0 9 7l-2.2-.9-2 3.4L6.6 11a7.7 7.7 0 0 0 0 2l-1.8 1.4 2 3.4L9 17a7.6 7.6 0 0 0 1.7 1l.3 2.2h4l.3-2.2a7.6 7.6 0 0 0 1.7-1l2.2.9 2-3.4z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M20 20l-3.5-3.5',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  send: 'M4 12l16-7-7 16-2.5-6.5z',
  chevdown: 'M5 9l7 7 7-7',
  chevright: 'M9 5l7 7-7 7',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4',
  book: 'M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 0-2 2zM5 4v16',
  list: 'M8 6h12M8 12h12M8 18h12|M4 6h.01M4 12h.01M4 18h.01',
  scrub: 'M4 7h16M4 12h10M4 17h7|M16 15l5 5M21 15l-5 5',
  chat: 'M5 5h14v10H9l-4 4z',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  refresh: 'M20 11a8 8 0 0 0-14-4M4 5v3h3|M4 13a8 8 0 0 0 14 4M20 19v-3h-3',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  key: 'M14 8a4 4 0 1 0-4 4l-1 1H7v2H5v2l-2 0v-2l6-6|M14.5 7.5h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M5 20c0-3.3 3-6 7-6s7 2.7 7 6',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  dot: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z|M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  link: 'M9 13a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-6-6l-1 1|M15 11a4 4 0 0 0-6-.5l-2 2a4 4 0 0 0 6 6l1-1',
  history: 'M12 7v5l3 2|M4 12a8 8 0 1 1 2.3 5.6M4 12H2m2 0l-.5-3',
  flag: 'M5 21V4h13l-2.5 4L18 12H5',
};
function Ic({ name, size = 18, sw = 1.7, color = 'currentColor', style }) {
  const d = ICON[name] || ICON.dot;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: 'none', ...style }} aria-hidden="true">
      {d.split('|').map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

// A subtly striped placeholder for imagery / dropped files (per house style).
function Placeholder({ label, h = 80, mono = true }) {
  return (
    <div style={{
      height: h, borderRadius: 10, border: '1px dashed var(--border-2)',
      background: 'repeating-linear-gradient(135deg, var(--surface-2) 0 9px, transparent 9px 18px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-faint)', fontSize: 11, fontFamily: mono ? 'var(--mono)' : 'inherit', letterSpacing: '.03em',
    }}>{label}</div>
  );
}

Object.assign(window, { CATS, Pill, Ic, Placeholder });
