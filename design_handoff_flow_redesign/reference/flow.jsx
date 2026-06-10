// flow.jsx — Direction 2 · "Flow"  (recommended)
// Left icon nav rail that scales to every current + roadmap feature, a slim
// trust band, and a spacious before→after workspace. Accent: green.
// Exports FlowRail + FlowShell (reused by Review / Vocabulary / Settings).

function FlowRail({ active = 'scrub', mode = 'dark' }) {
  const { Ic } = window;
  const items = [
    { id: 'scrub', icon: 'scrub', label: 'Scrub' },
    { id: 'review', icon: 'flag', label: 'Review', badge: 2 },
    { id: 'vocab', icon: 'book', label: 'Vocab' },
    { id: 'history', icon: 'history', label: 'History', soon: true },
    { id: 'chat', icon: 'chat', label: 'Chat', soon: true },
  ];
  return (
    <div className="ps-col" style={{ width: 78, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--surface)', padding: '12px 9px', gap: 4 }}>
      <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--acc)', display: 'grid', placeItems: 'center', margin: '2px auto 12px' }}>
        <Ic name="shield" size={22} color="var(--acc-ink)" sw={1.9} />
      </div>
      {items.map((it) => (
        <button key={it.id} className="ps-rail-item" aria-current={active === it.id ? 'page' : undefined}
          style={it.soon ? { opacity: .5 } : null}>
          <span style={{ position: 'relative' }}>
            <Ic name={it.icon} size={21} />
            {it.badge && <span style={{ position: 'absolute', top: -5, right: -8, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: 'var(--warn)', color: '#1a1205', fontSize: 9.5, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{it.badge}</span>}
          </span>
          {it.label}
          {it.soon && <span style={{ fontSize: 8, letterSpacing: '.06em', color: 'var(--text-faint)' }}>SOON</span>}
        </button>
      ))}
      <div className="ps-grow" />
      <window.ThemeToggle mode={mode} vertical />
      <button className="ps-rail-item" aria-current={active === 'settings' ? 'page' : undefined} aria-label="Settings"><Ic name="settings" size={20} />Settings</button>
      <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--surface-3)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', margin: '6px auto 0', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>AC</div>
    </div>
  );
}

function FlowShell({ mode = 'dark', active = 'scrub', title, subtitle, headerRight, trust, children }) {
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex' }}>
      <FlowRail active={active} mode={mode} />
      <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
        <div className="ps-row" style={{ justifyContent: 'space-between', padding: '15px 22px', gap: 16 }}>
          <div className="ps-col" style={{ gap: 3 }}>
            <span className="ps-h" style={{ fontSize: 19 }}>{title}</span>
            {subtitle && <span className="ps-dim" style={{ fontSize: 12.5 }}>{subtitle}</span>}
          </div>
          <div className="ps-row ps-gap10">{headerRight}</div>
        </div>
        {trust !== false && (
          <div className="ps-row ps-gap8" style={{ margin: '0 22px 4px', padding: '8px 13px', borderRadius: 9, background: 'var(--acc-tint)', color: 'var(--acc)', fontSize: 12, fontWeight: 500 }}>
            <window.Ic name="lock" size={14} color="var(--acc)" />
            Local-first — real values never leave this machine. Only stable tokens are sent to Claude.
          </div>
        )}
        <div className="ps-grow" style={{ minHeight: 0, overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
}

function FlowWorkspace({ mode = 'dark' }) {
  const { Ic, Pill, Scrubbed, SAMPLE } = window;
  const statusRight = (
    <>
      <span className="ps-chip"><Ic name="check" size={14} color="var(--ok)" /> claude ready</span>
      <div className="ps-seg" role="group" aria-label="Mode">
        <button aria-pressed="false">Observe</button>
        <button aria-pressed="true">Enforce</button>
      </div>
    </>
  );
  return (
    <FlowShell mode={mode} active="scrub" title="Scrub & Send" subtitle="Paste sensitive text — it's tokenized before anything is sent." headerRight={statusRight}>
      <div className="ps-col" style={{ height: '100%', padding: '8px 22px 0' }}>
        {/* before → after */}
        <div className="ps-row ps-grow" style={{ gap: 0, alignItems: 'stretch', minHeight: 0 }}>
          <div className="ps-panel ps-col ps-grow" style={{ minWidth: 0 }}>
            <div className="ps-row ps-gap8" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <Ic name="doc" size={15} color="var(--text-faint)" />
              <span className="ps-eyebrow">Your text — stays on device</span>
            </div>
            <div className="ps-mono ps-grow" style={{ padding: 16, fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflow: 'hidden', color: 'var(--text-dim)' }}>{SAMPLE.raw}</div>
          </div>

          <div className="ps-col" style={{ width: 56, alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--acc)', display: 'grid', placeItems: 'center', boxShadow: '0 4px 14px var(--acc-tint)' }}>
              <Ic name="arrow" size={20} color="var(--acc-ink)" sw={2} />
            </div>
          </div>

          <div className="ps-panel ps-col ps-grow" style={{ minWidth: 0, borderColor: 'var(--acc-line)' }}>
            <div className="ps-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
              <span className="ps-row ps-gap8"><Ic name="shield" size={15} color="var(--acc)" /><span className="ps-eyebrow" style={{ color: 'var(--acc)' }}>Safe to send</span></span>
              <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="copy" size={13} /> Copy</button>
            </div>
            <div className="ps-mono ps-grow" style={{ padding: 16, fontSize: 12.5, lineHeight: 2, whiteSpace: 'pre-wrap', overflow: 'hidden', color: 'var(--text)' }}>
              <Scrubbed runs={SAMPLE.scrubbed} />
            </div>
          </div>
        </div>

        {/* protected summary + send */}
        <div className="ps-row ps-gap16" style={{ padding: '14px 2px 16px', justifyContent: 'space-between' }}>
          <div className="ps-row ps-gap10" style={{ flexWrap: 'wrap' }}>
            <span className="ps-row ps-gap6" style={{ fontSize: 12.5, fontWeight: 600 }}><Ic name="check" size={15} color="var(--ok)" /> 9 items protected</span>
            <span className="ps-vdiv" style={{ height: 16, alignSelf: 'center' }} />
            {['customer', 'ip', 'host', 'email', 'phone'].map((c) => <Pill key={c} cat={c} dot>{window.CATS[c].label}</Pill>)}
            <span className="ps-chip ps-faint">+4 more</span>
          </div>
          <div className="ps-row ps-gap12">
            <span className="ps-faint" style={{ fontSize: 11.5, maxWidth: 150, textAlign: 'right', lineHeight: 1.35 }}>0 credentials found · tokens stay on this device</span>
            <button className="ps-btn ps-btn-primary" style={{ height: 42, padding: '0 20px', fontSize: 14 }}><Ic name="send" size={16} /> Send to Claude</button>
          </div>
        </div>
      </div>
    </FlowShell>
  );
}

Object.assign(window, { FlowRail, FlowShell, FlowWorkspace });
