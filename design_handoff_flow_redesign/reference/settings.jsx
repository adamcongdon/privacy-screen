// settings.jsx — Settings: modes, LLM judge, updates, customer names, data.

function SettingsScreen({ mode = 'dark' }) {
  const { Ic } = window;

  const Card = ({ icon, title, desc, children, accent }) => (
    <div className="ps-panel" style={{ padding: 18 }}>
      <div className="ps-row ps-gap10" style={{ marginBottom: desc ? 4 : 14 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: accent ? 'var(--acc-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flex: 'none' }}>
          <Ic name={icon} size={16} color={accent ? 'var(--acc)' : 'var(--text-dim)'} />
        </div>
        <span className="ps-h" style={{ fontSize: 14.5 }}>{title}</span>
      </div>
      {desc && <p className="ps-faint" style={{ fontSize: 12, lineHeight: 1.45, margin: '0 0 14px 40px' }}>{desc}</p>}
      {children}
    </div>
  );

  const Radio = ({ on, title, desc, rec }) => (
    <button className="ps-row ps-gap10" style={{ width: '100%', textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer',
      border: `1px solid ${on ? 'var(--acc)' : 'var(--border)'}`, background: on ? 'var(--acc-tint)' : 'var(--surface-2)' }}>
      <span style={{ width: 16, height: 16, borderRadius: '50%', flex: 'none', marginTop: 1, border: `2px solid ${on ? 'var(--acc)' : 'var(--border-2)'}`, display: 'grid', placeItems: 'center' }}>
        {on && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--acc)' }} />}
      </span>
      <span className="ps-col" style={{ gap: 2 }}>
        <span className="ps-row ps-gap8"><span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>{rec && <span className="ps-badge" style={{ height: 18, background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent' }}>recommended</span>}</span>
        <span className="ps-faint" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{desc}</span>
      </span>
    </button>
  );

  return (
    <window.FlowShell mode={mode} active="settings" title="Settings" subtitle="Modes, the local LLM judge, updates, and your customer vocabulary." trust={false}>
      <div className="ps-row ps-gap16" style={{ height: '100%', padding: '4px 22px 0', alignItems: 'flex-start' }}>
        {/* left column */}
        <div className="ps-col ps-gap16 ps-grow" style={{ minWidth: 0 }}>
          <Card icon="bolt" title="Screening mode" accent>
            <div className="ps-col ps-gap8">
              <Radio title="Observe" desc="Detect and log only — nothing is blocked or mutated." />
              <Radio on title="Enforce" desc="Block credentials and replace PII with tokens before send." rec />
              <Radio title="Disabled" desc="Emergency bypass — text passes through untouched." />
            </div>
          </Card>

          <Card icon="user" title="Customer names" desc="Names added here are always tokenized as {CUSTOMER}.">
            <div className="ps-row" style={{ flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
              {['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Soylent'].map((n) => (
                <span key={n} className="ps-chip" style={{ height: 28 }}>{n}<Ic name="x" size={12} /></span>
              ))}
            </div>
            <div className="ps-row ps-gap8">
              <div className="ps-input ps-row" style={{ flex: 1, alignItems: 'center', color: 'var(--text-faint)' }}>Add a name…</div>
              <button className="ps-btn ps-btn-soft ps-btn-sm"><Ic name="plus" size={14} /> Add</button>
            </div>
          </Card>
        </div>

        {/* right column */}
        <div className="ps-col ps-gap16 ps-grow" style={{ minWidth: 0 }}>
          <Card icon="sparkle" title="Local LLM judge" accent>
            <div className="ps-inset" style={{ padding: 13, marginBottom: 12 }}>
              <div className="ps-row" style={{ justifyContent: 'space-between' }}>
                <div className="ps-row ps-gap10">
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--surface-3)', display: 'grid', placeItems: 'center' }}><Ic name="sparkle" size={17} color="var(--acc)" /></div>
                  <div className="ps-col">
                    <span style={{ fontSize: 13, fontWeight: 600 }}>qwen2.5-1.5b</span>
                    <span className="ps-faint" style={{ fontSize: 11 }}>1.0 GB · Apache-2.0 · 29 languages</span>
                  </div>
                </div>
                <span className="ps-badge" style={{ background: 'var(--ok-tint)', color: 'var(--ok)', borderColor: 'transparent' }}><Ic name="check" size={11} color="var(--ok)" /> Installed</span>
              </div>
            </div>
            <div className="ps-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="ps-col">
                <span style={{ fontSize: 13, fontWeight: 600 }}>Enable judge</span>
                <span className="ps-faint" style={{ fontSize: 11.5 }}>Second-pass review of already-scrubbed text. Runs fully local.</span>
              </div>
              <button className="ps-toggle" role="switch" aria-checked="true" aria-label="Enable judge" />
            </div>
          </Card>

          <Card icon="refresh" title="Updates" desc="Opt-in. No telemetry; SHA-256 verified before any swap.">
            <div className="ps-row ps-gap10" style={{ marginBottom: 12 }}>
              <div className="ps-seg" role="group" aria-label="Channel">
                <button aria-pressed="false">Off</button>
                <button aria-pressed="true">Stable</button>
                <button aria-pressed="false">Beta</button>
              </div>
              <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="refresh" size={13} /> Check now</button>
            </div>
            <div className="ps-row ps-gap8" style={{ fontSize: 12 }}>
              <span className="ps-dim">On <span className="ps-mono">v1.4.0</span></span>
              <span className="ps-faint">·</span>
              <span style={{ color: 'var(--ok)' }}>Up to date</span>
            </div>
          </Card>

          <Card icon="lock" title="Data & privacy">
            <div className="ps-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="ps-dim" style={{ fontSize: 12, lineHeight: 1.4 }}>Vocabulary database<br /><span className="ps-faint ps-mono" style={{ fontSize: 11 }}>~/.privacy-screen/vocab.db</span></span>
              <button className="ps-btn ps-btn-danger ps-btn-sm"><Ic name="trash" size={13} /> Clear vocab</button>
            </div>
          </Card>
        </div>
      </div>
    </window.FlowShell>
  );
}
window.SettingsScreen = SettingsScreen;
