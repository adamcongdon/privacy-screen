// states.jsx — empty & error states + a PWA/mobile frame.

function MiniBar({ title, right }) {
  const { Ic } = window;
  return (
    <div className="ps-row" style={{ height: 42, padding: '0 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', gap: 10 }}>
      <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--acc)', display: 'grid', placeItems: 'center', flex: 'none' }}><Ic name="shield" size={13} color="var(--acc-ink)" /></div>
      <span className="ps-mono" style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
      <div className="ps-grow" />
      {right}
    </div>
  );
}

function StateEmpty({ mode = 'dark' }) {
  const { Ic, Placeholder } = window;
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex', flexDirection: 'column' }}>
      <MiniBar title="privacy-screen" right={<span className="ps-chip" style={{ height: 24 }}><span className="ps-dot" style={{ background: 'var(--ok)' }} /> ready</span>} />
      <div className="ps-row ps-grow" style={{ alignItems: 'stretch' }}>
        <div className="ps-col ps-grow" style={{ padding: 16, borderRight: '1px solid var(--border)' }}>
          <span className="ps-eyebrow" style={{ marginBottom: 10 }}>Your text</span>
          <div className="ps-inset ps-grow" style={{ display: 'grid', placeItems: 'center', borderStyle: 'dashed' }}>
            <div className="ps-col" style={{ alignItems: 'center', gap: 8, color: 'var(--text-faint)' }}>
              <Ic name="doc" size={22} /><span style={{ fontSize: 12 }}>Paste, type, or drop a file</span>
            </div>
          </div>
        </div>
        <div className="ps-col ps-grow" style={{ padding: 16 }}>
          <span className="ps-eyebrow" style={{ marginBottom: 10 }}>Safe to send</span>
          <div className="ps-grow" style={{ display: 'grid', placeItems: 'center' }}>
            <div className="ps-col" style={{ alignItems: 'center', gap: 10, textAlign: 'center', maxWidth: 220 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--acc-tint)', display: 'grid', placeItems: 'center' }}><Ic name="shield" size={22} color="var(--acc)" /></div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Nothing to scrub yet</span>
              <span className="ps-faint" style={{ fontSize: 11.5, lineHeight: 1.5 }}>Tokens will appear here as soon as you add text. Real values never leave this machine.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateCredential({ mode = 'dark' }) {
  const { Ic } = window;
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex', flexDirection: 'column' }}>
      <MiniBar title="privacy-screen" right={<span className="ps-badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' }}><Ic name="alert" size={12} color="var(--danger)" /> blocked</span>} />
      <div className="ps-col ps-grow" style={{ padding: 16, gap: 12 }}>
        <div className="ps-panel" style={{ padding: 14, borderColor: 'var(--danger-border)', background: 'var(--danger-bg)' }}>
          <div className="ps-row ps-gap8" style={{ marginBottom: 8 }}><Ic name="alert" size={17} color="var(--danger)" /><span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--danger)' }}>Credential detected — send disabled</span></div>
          <p className="ps-mono" style={{ fontSize: 11.5, color: 'var(--danger)', margin: '0 0 4px', opacity: .9 }}>line 3 · AKIA••••••••••••EXAMPLE</p>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0, lineHeight: 1.5 }}>Credentials are never tokenized — they're blocked outright. Remove the secret to continue.</p>
        </div>
        <div className="ps-inset ps-grow ps-mono" style={{ padding: 13, fontSize: 12, lineHeight: 1.8, color: 'var(--text-dim)' }}>
          export AWS_ACCESS_KEY_ID=<span style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--danger-border)' }}>AKIAIOSFODNN7EXAMPLE</span><br />
          deploy --region us-east-1 --proxy {'{IP_1}'}
        </div>
        <div className="ps-row" style={{ justifyContent: 'space-between' }}>
          <span className="ps-faint" style={{ fontSize: 11.5 }}>Send stays disabled while a credential is present.</span>
          <button className="ps-btn ps-btn-primary" disabled style={{ height: 38 }}><Ic name="send" size={14} /> Send blocked</button>
        </div>
      </div>
    </div>
  );
}

function StateNoClaude({ mode = 'dark' }) {
  const { Ic } = window;
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex', flexDirection: 'column' }}>
      <MiniBar title="privacy-screen" right={<span className="ps-badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' }}><Ic name="x" size={12} color="var(--danger)" /> claude: missing</span>} />
      <div className="ps-grow" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="ps-col" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 380, gap: 12 }}>
          <div style={{ width: 50, height: 50, borderRadius: 14, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', display: 'grid', placeItems: 'center' }}><Ic name="alert" size={26} color="var(--danger)" /></div>
          <span className="ps-h" style={{ fontSize: 17 }}>Claude Code not found on PATH</span>
          <p className="ps-dim" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>Inference runs through your local <span className="ps-mono">claude</span> CLI — the server won't send anything until it's installed and logged in.</p>
          <div className="ps-inset ps-mono" style={{ padding: '10px 12px', fontSize: 11.5, color: 'var(--text-dim)', textAlign: 'left', width: '100%' }}>
            <div>$ claude --version <span style={{ color: 'var(--text-faint)' }}># 2.x required</span></div>
            <div>$ claude login</div>
          </div>
          <div className="ps-row ps-gap8" style={{ marginTop: 4 }}>
            <button className="ps-btn ps-btn-soft ps-btn-sm"><Ic name="refresh" size={13} /> Re-check</button>
            <button className="ps-btn ps-btn-primary ps-btn-sm"><Ic name="link" size={13} /> Install guide</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateOffline({ mode = 'dark' }) {
  const { Ic } = window;
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex', flexDirection: 'column' }}>
      <MiniBar title="privacy-screen" right={<span className="ps-chip" style={{ height: 24 }}><span className="ps-dot" style={{ background: 'var(--warn)' }} /> offline</span>} />
      <div className="ps-grow" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="ps-col" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 320, gap: 12 }}>
          <div style={{ width: 50, height: 50, borderRadius: 14, background: 'var(--warn-tint)', display: 'grid', placeItems: 'center' }}><Ic name="bolt" size={26} color="var(--warn)" /></div>
          <span className="ps-h" style={{ fontSize: 16 }}>Local server unreachable</span>
          <p className="ps-dim" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>Scrubbing still works on-device. Reconnect to send to Claude.</p>
          <button className="ps-btn ps-btn-soft ps-btn-sm" style={{ marginTop: 2 }}><Ic name="refresh" size={13} /> Retry connection</button>
        </div>
      </div>
    </div>
  );
}

// ── PWA / mobile ────────────────────────────────────────────
function PWAMobile({ mode = 'dark' }) {
  const { Ic, Pill, Scrubbed, SAMPLE } = window;
  const Tab = ({ ic, label, on }) => (
    <button className="ps-col" style={{ alignItems: 'center', gap: 3, flex: 1, border: 0, background: 'transparent', cursor: 'pointer', color: on ? 'var(--acc)' : 'var(--text-faint)', fontSize: 9.5, fontWeight: 600 }}>
      <Ic name={ic} size={20} /> {label}
    </button>
  );
  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'flex', flexDirection: 'column' }}>
      {/* status bar */}
      <div className="ps-row" style={{ justifyContent: 'space-between', padding: '8px 18px 4px', fontSize: 12, fontWeight: 600 }}>
        <span>9:41</span><span className="ps-row ps-gap6"><Ic name="bolt" size={13} /><Ic name="lock" size={13} /></span>
      </div>
      <div className="ps-row" style={{ padding: '6px 16px 10px', gap: 9, alignItems: 'center' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--acc)', display: 'grid', placeItems: 'center' }}><Ic name="shield" size={16} color="var(--acc-ink)" /></div>
        <span className="ps-h" style={{ fontSize: 15, whiteSpace: 'nowrap' }}>Scrub &amp; Send</span>
        <div className="ps-grow" />
        <span className="ps-chip" style={{ height: 26 }}><span className="ps-dot" style={{ background: 'var(--acc)' }} /> Enforce</span>
      </div>
      <div className="ps-row ps-gap6" style={{ margin: '0 16px 10px', padding: '7px 11px', borderRadius: 9, background: 'var(--acc-tint)', color: 'var(--acc)', fontSize: 11, fontWeight: 500 }}>
        <Ic name="lock" size={13} color="var(--acc)" /> Real values stay on this phone
      </div>

      <div className="ps-col ps-grow ps-gap10" style={{ padding: '0 16px', minHeight: 0 }}>
        <div className="ps-panel" style={{ padding: 12 }}>
          <span className="ps-eyebrow">Your text</span>
          <p className="ps-mono ps-dim" style={{ fontSize: 11, lineHeight: 1.6, margin: '8px 0 0', maxHeight: 92, overflow: 'hidden' }}>{SAMPLE.raw}</p>
        </div>
        <div className="ps-panel" style={{ padding: 12, borderColor: 'var(--acc-line)' }}>
          <div className="ps-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}><span className="ps-eyebrow" style={{ color: 'var(--acc)' }}>Safe to send · 9 tokens</span><Ic name="copy" size={14} color="var(--text-faint)" /></div>
          <p className="ps-mono" style={{ fontSize: 11, lineHeight: 1.9, margin: 0, maxHeight: 120, overflow: 'hidden' }}><Scrubbed runs={SAMPLE.scrubbed.slice(0, 12)} /></p>
        </div>
      </div>

      <div style={{ padding: '12px 16px' }}>
        <button className="ps-btn ps-btn-primary" style={{ width: '100%', height: 46, fontSize: 15 }}><Ic name="send" size={17} /> Send to Claude</button>
      </div>
      {/* install hint */}
      <div className="ps-row ps-gap8" style={{ margin: '0 16px 10px', padding: '9px 12px', borderRadius: 10, border: '1px dashed var(--border-2)', fontSize: 11 }}>
        <Ic name="plus" size={14} color="var(--acc)" /><span className="ps-dim">Add to Home Screen — runs offline as an app</span>
      </div>
      <div className="ps-row" style={{ borderTop: '1px solid var(--border)', padding: '9px 8px 14px', background: 'var(--surface)' }}>
        <Tab ic="scrub" label="Scrub" on /><Tab ic="flag" label="Review" /><Tab ic="book" label="Vocab" /><Tab ic="chat" label="Chat" />
      </div>
    </div>
  );
}

Object.assign(window, { StateEmpty, StateCredential, StateNoClaude, StateOffline, PWAMobile });
