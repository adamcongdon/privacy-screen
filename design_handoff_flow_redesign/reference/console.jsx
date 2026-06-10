// console.jsx — Direction 1 · "Console"
// Evolves the current dense, multi-pane developer tool. Hairline borders,
// three columns, a quiet status bar carrying the trust signal. Accent: blue.

function ConsoleWorkspace({ mode = 'dark' }) {
  const { Ic, Pill, Scrubbed, SAMPLE } = window;
  const Hdr = ({ children, right }) => (
    <div className="ps-row" style={{ justifyContent: 'space-between', padding: '9px 13px', borderBottom: '1px solid var(--border)' }}>
      <span className="ps-eyebrow">{children}</span>
      {right}
    </div>
  );

  return (
    <div className={`ps-root ps-${mode} ps-acc-console`} style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div className="ps-row" style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', gap: 14, background: 'var(--surface)' }}>
        <div className="ps-row ps-gap8">
          <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--acc-tint)', display: 'grid', placeItems: 'center' }}>
            <Ic name="shield" size={16} color="var(--acc)" />
          </div>
          <span className="ps-mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em' }}>privacy-screen</span>
          <span className="ps-badge ps-mono" style={{ height: 19, fontSize: 10 }}>v1.4.0</span>
        </div>
        <div className="ps-grow" />
        <span className="ps-chip" style={{ height: 24 }}>
          <span className="ps-dot" style={{ background: 'var(--acc)' }} /> Enforce
        </span>
        <span className="ps-row ps-gap6 ps-faint" style={{ fontSize: 11.5 }}>
          <Ic name="check" size={13} color="var(--ok)" /> claude 2.1.4
        </span>
        <span className="ps-row ps-gap6 ps-faint" style={{ fontSize: 11.5 }}>
          <span className="ps-dot" style={{ background: 'var(--ok)' }} /> online
        </span>
        <window.ThemeToggle mode={mode} />
        <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label="Settings"><Ic name="settings" size={15} /></button>
      </div>

      {/* Body — three columns */}
      <div className="ps-row ps-grow" style={{ alignItems: 'stretch', minHeight: 0 }}>
        {/* Input */}
        <div className="ps-col" style={{ width: '35%' }}>
          <Hdr right={<span className="ps-row ps-gap6 ps-faint" style={{ fontSize: 11 }}><span className="ps-dot" style={{ background: 'var(--ok)' }} />ready</span>}>Input</Hdr>
          <div className="ps-col ps-grow ps-gap10" style={{ padding: 13, minHeight: 0 }}>
            <div className="ps-textarea ps-mono ps-grow" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', overflow: 'hidden', color: 'var(--text-dim)', lineHeight: 1.65 }}>
              {SAMPLE.raw}
            </div>
            <div className="ps-row ps-gap8">
              <span className="ps-chip"><Ic name="doc" size={14} /> incident-notes.md</span>
              <span className="ps-chip ps-faint" style={{ borderStyle: 'dashed', background: 'transparent' }}><Ic name="plus" size={14} /> drop files</span>
            </div>
          </div>
        </div>
        <div className="ps-vdiv" />

        {/* Scrubbed output */}
        <div className="ps-col ps-grow">
          <Hdr right={
            <div className="ps-row ps-gap10">
              <div className="ps-seg"><button aria-pressed="true"><Ic name="scrub" size={13} />source</button><button aria-pressed="false"><Ic name="eye" size={13} />rendered</button></div>
              <span className="ps-faint ps-mono" style={{ fontSize: 11 }}>9 tokens</span>
            </div>
          }>Scrubbed output</Hdr>
          <div className="ps-col ps-grow" style={{ padding: 13, minHeight: 0 }}>
            <div className="ps-inset ps-grow ps-mono" style={{ padding: 13, fontSize: 12.5, lineHeight: 2, whiteSpace: 'pre-wrap', overflow: 'hidden', color: 'var(--text)' }}>
              <Scrubbed runs={SAMPLE.scrubbed} />
            </div>
            <div className="ps-row ps-gap10" style={{ marginTop: 11, justifyContent: 'space-between' }}>
              <span className="ps-faint" style={{ fontSize: 11.5 }}>Only tokens leave this machine.</span>
              <div className="ps-row ps-gap8">
                <button className="ps-btn ps-btn-soft ps-btn-sm"><Ic name="copy" size={14} /> Copy scrubbed</button>
                <button className="ps-btn ps-btn-primary ps-btn-sm"><Ic name="send" size={14} /> Send to Claude</button>
              </div>
            </div>
          </div>
        </div>
        <div className="ps-vdiv" />

        {/* Review + tokens rail */}
        <div className="ps-col" style={{ width: '25%', minWidth: 250 }}>
          <Hdr right={<span className="ps-badge" style={{ background: 'var(--warn-tint)', color: 'var(--warn)', borderColor: 'transparent' }}>2</span>}>Review queue</Hdr>
          <div className="ps-col ps-gap8" style={{ padding: 11 }}>
            {SAMPLE.review.map((r, i) => (
              <div key={i} className="ps-inset" style={{ padding: '9px 10px' }}>
                <div className="ps-row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
                  <span className="ps-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{r.span}</span>
                  <span className="ps-faint" style={{ fontSize: 10 }}>{Math.round(r.conf * 100)}%</span>
                </div>
                <div className="ps-faint ps-mono" style={{ fontSize: 10.5, marginBottom: 8, lineHeight: 1.4 }}>{r.ctx}</div>
                <div className="ps-row ps-gap6">
                  <button className="ps-btn ps-btn-sm" style={{ flex: 1, background: 'var(--ok-tint)', color: 'var(--ok)' }}><Ic name="check" size={13} />Confirm</button>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm" style={{ flex: 1 }}>Allow</button>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label="Ignore"><Ic name="x" size={13} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="ps-divider" />
          <div className="ps-col ps-gap6" style={{ padding: 11 }}>
            <span className="ps-eyebrow" style={{ marginBottom: 3 }}>Protected this session</span>
            {[['customer', 2], ['ip', 1], ['host', 1], ['email', 1], ['phone', 1], ['path', 1], ['url', 1], ['user', 1]].map(([c, n]) => (
              <div key={c} className="ps-row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                <Pill cat={c} dot>{`{${window.CATS[c].label.toUpperCase()}}`}</Pill>
                <span className="ps-faint ps-mono">{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status bar — quiet, persistent trust signal */}
      <div className="ps-row ps-gap16" style={{ height: 26, padding: '0 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)', fontSize: 11 }}>
        <span className="ps-row ps-gap6" style={{ color: 'var(--ok)' }}><Ic name="lock" size={12} color="var(--ok)" /> Local-first — nothing sent in clear</span>
        <span className="ps-vdiv" style={{ height: 12 }} />
        <span className="ps-faint">9 tokens · 0 credentials blocked</span>
        <div className="ps-grow" />
        <span className="ps-faint ps-row ps-gap6"><Ic name="sparkle" size={12} /> judge idle</span>
        <span className="ps-faint ps-mono">⌘K vocab</span>
      </div>
    </div>
  );
}
window.ConsoleWorkspace = ConsoleWorkspace;
