// legend.jsx — design-system + accessibility rationale board.

function SystemLegend({ mode = 'dark' }) {
  const { Ic, Pill, CATS } = window;
  const Swatch = ({ v, name }) => (
    <div className="ps-col ps-gap6" style={{ alignItems: 'center' }}>
      <div style={{ width: 52, height: 40, borderRadius: 8, background: v, border: '1px solid var(--border)' }} />
      <span className="ps-faint ps-mono" style={{ fontSize: 9.5 }}>{name}</span>
    </div>
  );
  const Card = ({ children, style }) => <div className="ps-panel" style={{ padding: 18, ...style }}>{children}</div>;

  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ padding: 26, overflow: 'hidden' }}>
      <div className="ps-row ps-gap10" style={{ marginBottom: 4 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--acc)', display: 'grid', placeItems: 'center' }}><Ic name="shield" size={18} color="var(--acc-ink)" /></div>
        <span className="ps-h" style={{ fontSize: 21, whiteSpace: 'nowrap' }}>Privacy Screen — Design System</span>
      </div>
      <p className="ps-dim" style={{ fontSize: 13, margin: '0 0 18px', maxWidth: 720, lineHeight: 1.5 }}>
        One accessible system, three layout directions. Every surface is engineered to WCAG&nbsp;AA in both themes; the
        navigation scales to the roadmap (history, chat-replacement, PWA). Below: the tokens that hold it together.
      </p>

      <div className="ps-row ps-gap16" style={{ alignItems: 'stretch' }}>
        {/* Type + a11y */}
        <Card style={{ width: 360, flex: 'none' }}>
          <span className="ps-eyebrow">Typeface</span>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-.02em', margin: '8px 0 1px' }}>IBM Plex Sans</div>
          <div className="ps-dim" style={{ fontSize: 12.5 }}>Interface · humanist, technical, highly legible</div>
          <div className="ps-mono" style={{ fontSize: 19, fontWeight: 500, margin: '14px 0 1px' }}>IBM Plex Mono</div>
          <div className="ps-dim" style={{ fontSize: 12.5 }}>Tokens, values &amp; code — {`{CUSTOMER_1}`} 10.0.5.3</div>
          <div className="ps-divider" style={{ margin: '16px 0' }} />
          <span className="ps-eyebrow">Accessibility — built in</span>
          <div className="ps-col ps-gap10" style={{ marginTop: 12 }}>
            {[
              ['check', 'AA contrast: 4.5:1 text · 3:1 UI'],
              ['scrub', 'Tokens name their category — never color-only'],
              ['eye', 'Visible 2px focus rings everywhere'],
              ['bolt', 'Hit targets ≥ 36px · reduced-motion'],
              ['lock', 'Status by icon + label, not hue'],
            ].map(([ic, t]) => (
              <div key={t} className="ps-row ps-gap8"><Ic name={ic} size={15} color="var(--acc)" style={{ marginTop: 1 }} /><span style={{ fontSize: 12.5, lineHeight: 1.3 }} className="ps-dim">{t}</span></div>
            ))}
          </div>
        </Card>

        {/* Color */}
        <Card style={{ flex: 1 }}>
          <span className="ps-eyebrow">Surfaces — dark &amp; light</span>
          <div className="ps-row ps-gap16" style={{ margin: '12px 0 6px' }}>
            <div className="ps-row ps-gap10"><Swatch v="#0d1117" name="bg" /><Swatch v="#151b23" name="surface" /><Swatch v="#1b232e" name="raised" /><Swatch v="#283140" name="border" /></div>
            <span className="ps-vdiv" style={{ height: 40 }} />
            <div className="ps-row ps-gap10"><Swatch v="#f4f6f9" name="bg" /><Swatch v="#ffffff" name="surface" /><Swatch v="#eef2f7" name="raised" /><Swatch v="#dde3ea" name="border" /></div>
          </div>
          <div className="ps-divider" style={{ margin: '14px 0' }} />
          <span className="ps-eyebrow">Accent — one per direction</span>
          <div className="ps-row ps-gap10" style={{ margin: '10px 0 4px', flexWrap: 'wrap' }}>
            {[['Console', '#4c8dff', '#1f6feb'], ['Flow', '#37d39a', '#0a8f5f'], ['Chat', '#b08bff', '#6d3fd6']].map(([n, d, l]) => (
              <div key={n} className="ps-chip" style={{ height: 32, paddingLeft: 6 }}>
                <span style={{ width: 16, height: 16, borderRadius: 5, background: d }} />
                <span style={{ width: 16, height: 16, borderRadius: 5, background: l }} />
                <span style={{ fontWeight: 600 }}>{n}</span>
              </div>
            ))}
          </div>
          <div className="ps-divider" style={{ margin: '14px 0' }} />
          <span className="ps-eyebrow">Token categories — color reinforces, text carries</span>
          <div className="ps-row" style={{ flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
            {Object.keys(CATS).map((c) => (
              <Pill key={c} cat={c} dot>{`{${CATS[c].label.toUpperCase()}}`}</Pill>
            ))}
          </div>
          <div className="ps-row ps-gap8" style={{ marginTop: 14 }}>
            <span className="ps-badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' }}><Ic name="alert" size={12} color="var(--danger)" /> Credentials are BLOCKED, never tokenized</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
window.SystemLegend = SystemLegend;
