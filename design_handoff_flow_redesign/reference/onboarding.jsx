// onboarding.jsx — first-run setup flow (centered, guided).

function OnboardingScreen({ mode = 'dark' }) {
  const { Ic } = window;
  const Step = ({ n, label, done, active }) => (
    <div className="ps-row ps-gap8">
      <div style={{ width: 22, height: 22, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
        background: done ? 'var(--acc)' : active ? 'var(--acc-tint)' : 'var(--surface-3)',
        color: done ? 'var(--acc-ink)' : active ? 'var(--acc)' : 'var(--text-faint)',
        border: active ? '1px solid var(--acc)' : '1px solid transparent' }}>
        {done ? <Ic name="check" size={13} color="var(--acc-ink)" sw={2.4} /> : n}
      </div>
      <span style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: done || active ? 'var(--text)' : 'var(--text-faint)' }}>{label}</span>
    </div>
  );

  return (
    <div className={`ps-root ps-${mode} ps-acc-flow`} style={{ display: 'grid', placeItems: 'center', padding: 24,
      background: mode === 'dark' ? 'radial-gradient(120% 90% at 50% -10%, #16241f 0%, var(--bg) 55%)' : 'radial-gradient(120% 90% at 50% -10%, #e7f5ee 0%, var(--bg) 55%)' }}>
      <div className="ps-panel" style={{ width: 680, boxShadow: 'var(--shadow)' }}>
        {/* steps header */}
        <div className="ps-row ps-gap20" style={{ padding: '16px 26px', borderBottom: '1px solid var(--border)', justifyContent: 'center' }}>
          <Step n={1} label="Connect" active />
          <span className="ps-faint">·</span>
          <Step n={2} label="Choose mode" />
          <span className="ps-faint">·</span>
          <Step n={3} label="Safety check" />
        </div>

        <div style={{ padding: '30px 40px 34px' }}>
          <div className="ps-col" style={{ alignItems: 'center', textAlign: 'center', marginBottom: 24 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--acc)', display: 'grid', placeItems: 'center', marginBottom: 14 }}>
              <Ic name="shield" size={30} color="var(--acc-ink)" sw={1.8} />
            </div>
            <h1 className="ps-h" style={{ fontSize: 23, margin: '0 0 6px' }}>Welcome to Privacy Screen</h1>
            <p className="ps-dim" style={{ fontSize: 13.5, margin: 0, maxWidth: 420, lineHeight: 1.5 }}>
              A local privacy gate between your prompts and the cloud. Let's make sure it's ready — this stays entirely on your machine.
            </p>
          </div>

          <div className="ps-col ps-gap10">
            <div className="ps-rowitem" style={{ background: 'var(--ok-tint)', borderColor: 'transparent' }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface)', display: 'grid', placeItems: 'center', flex: 'none' }}><Ic name="check" size={17} color="var(--ok)" /></div>
              <div className="ps-col ps-grow"><span style={{ fontSize: 13, fontWeight: 600 }}>Claude Code detected</span><span className="ps-faint ps-mono" style={{ fontSize: 11.5 }}>v2.1.4 · logged in · inference runs through your local session</span></div>
              <span className="ps-badge" style={{ background: 'var(--ok-tint)', color: 'var(--ok)', borderColor: 'transparent' }}>Ready</span>
            </div>
            <div className="ps-rowitem">
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface)', display: 'grid', placeItems: 'center', flex: 'none' }}><Ic name="lock" size={17} color="var(--text-dim)" /></div>
              <div className="ps-col ps-grow"><span style={{ fontSize: 13, fontWeight: 600 }}>No API key needed</span><span className="ps-faint" style={{ fontSize: 11.5 }}>Uses the OAuth session you already have. The server binds to 127.0.0.1 only.</span></div>
              <span className="ps-badge"><Ic name="check" size={11} /> Local</span>
            </div>
          </div>

          <div className="ps-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 26 }}>
            <span className="ps-faint" style={{ fontSize: 11.5 }}>You can change everything later in Settings.</span>
            <button className="ps-btn ps-btn-primary" style={{ height: 42, padding: '0 20px', fontSize: 14 }}>Continue <Ic name="arrow" size={16} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
window.OnboardingScreen = OnboardingScreen;
