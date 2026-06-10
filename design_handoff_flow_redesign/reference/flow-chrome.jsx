// flow-chrome.jsx — interactive rail + shell for the Flow prototype.

function FlowRail({ route, setRoute, theme, setTheme, reviewCount }) {
  const { Ic } = window;
  const items = [
    { id: 'scrub', icon: 'scrub', label: 'Scrub' },
    { id: 'review', icon: 'flag', label: 'Review', badge: reviewCount },
    { id: 'vocab', icon: 'book', label: 'Vocab' },
    { id: 'history', icon: 'history', label: 'History', soon: true },
    { id: 'chat', icon: 'chat', label: 'Chat', soon: true },
  ];
  return (
    <div className="ps-col" style={{ width: 80, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--surface)', padding: '12px 9px', gap: 4 }}>
      <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--acc)', display: 'grid', placeItems: 'center', margin: '2px auto 12px' }}>
        <Ic name="shield" size={23} color="var(--acc-ink)" sw={1.9} />
      </div>
      {items.map((it) => (
        <button key={it.id} className="ps-rail-item" aria-current={route === it.id ? 'page' : undefined}
          onClick={() => !it.soon && setRoute(it.id)} style={it.soon ? { opacity: .5, cursor: 'default' } : null}
          title={it.soon ? it.label + ' — coming soon' : it.label}>
          <span style={{ position: 'relative' }}>
            <Ic name={it.icon} size={21} />
            {!!it.badge && <span style={{ position: 'absolute', top: -5, right: -8, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: 'var(--warn)', color: '#1a1205', fontSize: 9.5, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{it.badge}</span>}
          </span>
          {it.label}
          {it.soon && <span style={{ fontSize: 8, letterSpacing: '.06em', color: 'var(--text-faint)' }}>SOON</span>}
        </button>
      ))}
      <div className="ps-grow" />
      <button className="ps-rail-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme" aria-label="Toggle color theme">
        <Ic name={theme === 'dark' ? 'sun' : 'moon'} size={20} />{theme === 'dark' ? 'Light' : 'Dark'}
      </button>
      <button className="ps-rail-item" aria-current={route === 'settings' ? 'page' : undefined} onClick={() => setRoute('settings')} aria-label="Settings">
        <Ic name="settings" size={20} />Settings
      </button>
      <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--surface-3)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', margin: '6px auto 0', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>AC</div>
    </div>
  );
}

function FlowShell({ theme, route, setRoute, setTheme, reviewCount, title, subtitle, headerRight, trust, children }) {
  return (
    <div className={`ps-root ps-${theme} ps-acc-flow`} style={{ display: 'flex', height: '100%' }}>
      <FlowRail route={route} setRoute={setRoute} theme={theme} setTheme={setTheme} reviewCount={reviewCount} />
      <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
        <div className="ps-row" style={{ justifyContent: 'space-between', padding: '15px 24px', gap: 16 }}>
          <div className="ps-col" style={{ gap: 3 }}>
            <span className="ps-h" style={{ fontSize: 20 }}>{title}</span>
            {subtitle && <span className="ps-dim" style={{ fontSize: 12.5 }}>{subtitle}</span>}
          </div>
          <div className="ps-row ps-gap10">{headerRight}</div>
        </div>
        {trust !== false && (
          <div className="ps-row ps-gap8" style={{ margin: '0 24px 6px', padding: '8px 13px', borderRadius: 9, background: 'var(--acc-tint)', color: 'var(--acc)', fontSize: 12, fontWeight: 500 }}>
            <window.Ic name="lock" size={14} color="var(--acc)" />
            Local-first — real values never leave this machine. Only stable tokens are sent to Claude.
          </div>
        )}
        <div className="ps-grow" style={{ minHeight: 0, overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

Object.assign(window, { FlowRail, FlowShell });
