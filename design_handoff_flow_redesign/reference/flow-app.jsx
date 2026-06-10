// flow-app.jsx — interactive Flow prototype: state, Scrub screen, mount.
const { useState, useMemo, useRef, useEffect } = React;

// Render scrub runs as pills (+ credential chips).
function RunsView({ runs }) {
  const { Pill, Ic } = window;
  return runs.map((r, i) => {
    if (r.t === 'text') return <span key={i}>{r.v}</span>;
    if (r.t === 'cred') return (
      <span key={i} style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '1px 6px', borderRadius: 5, border: '1px solid var(--danger-border)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Ic name="alert" size={12} color="var(--danger)" /> blocked
      </span>
    );
    return <Pill key={i} cat={r.cat}>{r.token}</Pill>;
  });
}

// Build a plausible deanonymized reply that references detected tokens.
function buildReply(tokens) {
  const get = (c) => tokens.find((t) => t.cat === c);
  const host = get('host'), ip = get('ip'), user = get('user'), path = get('path');
  const custs = tokens.filter((t) => t.cat === 'customer');
  const req = custs[1] || custs[0];
  const R = [];
  R.push("Here's what I'd check on ");
  R.push(host ? { ...host } : 'the backup proxy');
  R.push(' before it can reach ');
  R.push(path ? { ...path } : 'the repository');
  R.push(':\n\n1. Confirm ');
  R.push(user ? { ...user } : 'the service account');
  R.push(' has write permission on the share.\n2. From ');
  R.push(ip ? { ...ip } : 'the proxy host');
  R.push(', test connectivity to the NAS, then re-run the validation job.\n3. Have ');
  R.push(req ? { ...req } : 'the requester');
  R.push(" verify no firewall rule changed overnight.\n\nIf it still fails, paste the proxy log and I'll trace the auth handshake.");
  return R;
}

function ScrubScreen(props) {
  const { Ic } = window;
  const { text, setText, scrub, mode, toast } = props;
  const { runs, tokens, credentials } = scrub;
  const blocked = mode === 'enforce' && credentials.length > 0;
  const empty = !text.trim();

  const [phase, setPhase] = useState('compose'); // compose | streaming | done
  const [shown, setShown] = useState(0);         // streamed run count
  const [showWire, setShowWire] = useState(false);
  const reply = useMemo(() => buildReply(tokens), [phase]); // freeze at send time
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);
  // Editing returns to compose.
  useEffect(() => { if (phase !== 'compose') { setPhase('compose'); setShown(0); } /* eslint-disable-next-line */ }, [text]);

  const send = () => {
    if (blocked || empty || phase === 'streaming') return;
    setPhase('streaming'); setShown(0);
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      setShown((n) => {
        if (n >= reply.length) { clearInterval(timer.current); setPhase('done'); return n; }
        return n + 1;
      });
    }, 140);
  };
  const reset = () => { clearInterval(timer.current); setPhase('compose'); setShown(0); setShowWire(false); };

  const headerRight = (
    <>
      <span className="ps-chip"><Ic name="check" size={14} color="var(--ok)" /> claude ready</span>
      <div className="ps-seg" role="group" aria-label="Mode">
        <button aria-pressed={mode === 'observe'} onClick={() => props.setMode('observe')}>Observe</button>
        <button aria-pressed={mode === 'enforce'} onClick={() => props.setMode('enforce')}>Enforce</button>
      </div>
    </>
  );

  const Deanon = ({ runs }) => runs.map((r, i) => {
    if (typeof r === 'string') return <span key={i}>{r}</span>;
    if (showWire) return <window.Pill key={i} cat={r.cat}>{r.token}</window.Pill>;
    return <span key={i} title={`sent as ${r.token}`} style={{ borderBottom: `1.5px dotted ${window.CATS[r.cat].color}`, paddingBottom: 1 }}>{r.real}</span>;
  });

  return (
    <window.FlowShell {...props.shell} reviewCount={props.reviewCount} title="Scrub & Send"
      subtitle="Paste sensitive text — it's tokenized before anything is sent." headerRight={headerRight}>
      <div className="ps-col" style={{ height: '100%', padding: '8px 24px 0' }}>
        <div className="ps-row ps-grow" style={{ gap: 0, alignItems: 'stretch', minHeight: 0 }}>
          {/* input */}
          <div className="ps-panel ps-col ps-grow" style={{ minWidth: 0 }}>
            <div className="ps-row ps-gap8" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
              <span className="ps-row ps-gap8"><Ic name="doc" size={15} color="var(--text-faint)" /><span className="ps-eyebrow">Your text — stays on device</span></span>
              {!empty && <button className="ps-btn ps-btn-ghost ps-btn-sm" onClick={() => setText('')}><Ic name="x" size={13} /> Clear</button>}
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
              placeholder="Paste or type text containing sensitive data…"
              className="ps-mono ps-grow" style={{ padding: 16, fontSize: 12.5, lineHeight: 1.7, border: 0, background: 'transparent', color: 'var(--text-dim)', resize: 'none', outline: 'none' }} />
          </div>

          <div className="ps-col" style={{ width: 56, alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: blocked ? 'var(--danger)' : 'var(--acc)', display: 'grid', placeItems: 'center', boxShadow: '0 4px 14px var(--acc-tint)' }}>
              <Ic name={blocked ? 'alert' : 'arrow'} size={20} color={blocked ? '#fff' : 'var(--acc-ink)'} sw={2} />
            </div>
          </div>

          {/* output */}
          <div className="ps-panel ps-col ps-grow" style={{ minWidth: 0, borderColor: blocked ? 'var(--danger-border)' : 'var(--acc-line)' }}>
            {phase === 'compose' ? (
              <>
                <div className="ps-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span className="ps-row ps-gap8"><Ic name="shield" size={15} color={blocked ? 'var(--danger)' : 'var(--acc)'} /><span className="ps-eyebrow" style={{ color: blocked ? 'var(--danger)' : 'var(--acc)' }}>{blocked ? 'Cannot send' : 'Safe to send'}</span></span>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(runs.map((r) => r.t === 'token' ? r.token : r.t === 'cred' ? '[BLOCKED]' : r.v).join('')); toast('Scrubbed text copied'); }}><Ic name="copy" size={13} /> Copy</button>
                </div>
                {blocked && (
                  <div className="ps-row ps-gap8" style={{ margin: 12, marginBottom: 0, padding: '9px 12px', borderRadius: 9, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                    <Ic name="alert" size={15} color="var(--danger)" /><span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Credential detected — remove it to send. Credentials are never tokenized.</span>
                  </div>
                )}
                <div className="ps-mono ps-grow" style={{ padding: 16, fontSize: 12.5, lineHeight: 2, whiteSpace: 'pre-wrap', overflow: 'auto', color: 'var(--text)' }}>
                  {empty ? <span className="ps-faint">Tokens will appear here as you type.</span> : <RunsView runs={runs} />}
                </div>
              </>
            ) : (
              <>
                <div className="ps-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span className="ps-row ps-gap8"><Ic name="sparkle" size={15} color="var(--acc)" /><span className="ps-eyebrow" style={{ color: 'var(--acc)' }}>Claude{phase === 'streaming' ? ' · replying…' : ''}</span></span>
                  <div className="ps-seg" role="group" aria-label="View">
                    <button aria-pressed={!showWire} onClick={() => setShowWire(false)}><Ic name="eye" size={12} />Real</button>
                    <button aria-pressed={showWire} onClick={() => setShowWire(true)}><Ic name="scrub" size={12} />Wire</button>
                  </div>
                </div>
                <div className="ps-mono ps-grow" style={{ padding: 16, fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap', overflow: 'auto', color: 'var(--text)' }}>
                  <Deanon runs={reply.slice(0, shown)} />{phase === 'streaming' && <span style={{ color: 'var(--acc)' }}>▍</span>}
                </div>
                <div className="ps-row ps-gap8" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', color: 'var(--text-faint)', fontSize: 11 }}>
                  <Ic name="lock" size={12} /> {showWire ? 'Exact bytes sent to Claude — only tokens.' : 'Deanonymized for you. Claude only ever saw the tokens.'}
                </div>
              </>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="ps-row ps-gap16" style={{ padding: '14px 2px 16px', justifyContent: 'space-between' }}>
          <div className="ps-row ps-gap10" style={{ flexWrap: 'wrap', minHeight: 30, alignItems: 'center' }}>
            {tokens.length > 0 ? (
              <>
                <span className="ps-row ps-gap6" style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}><Ic name="check" size={15} color="var(--ok)" /><span>{tokens.length} item{tokens.length === 1 ? '' : 's'} protected</span></span>
                <span className="ps-vdiv" style={{ height: 16, alignSelf: 'center' }} />
                {[...new Set(tokens.map((t) => t.cat))].slice(0, 5).map((c) => <window.Pill key={c} cat={c} dot>{window.CATS[c].label}</window.Pill>)}
                {credentials.length > 0 && <span className="ps-badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' }}><Ic name="alert" size={11} color="var(--danger)" /> {credentials.length} credential{credentials.length === 1 ? '' : 's'}</span>}
              </>
            ) : <span className="ps-faint" style={{ fontSize: 12 }}>{mode === 'disabled' ? 'Screening disabled — text passes through untouched.' : 'No sensitive values detected yet.'}</span>}
          </div>
          <div className="ps-row ps-gap12">
            {phase === 'done'
              ? <button className="ps-btn ps-btn-soft" style={{ height: 42, padding: '0 18px' }} onClick={reset}><Ic name="plus" size={15} /> New message</button>
              : phase === 'streaming'
                ? <button className="ps-btn ps-btn-ghost" style={{ height: 42, padding: '0 18px' }} onClick={reset}><Ic name="x" size={15} /> Stop</button>
                : <>
                    <span className="ps-faint" style={{ fontSize: 11.5, maxWidth: 150, textAlign: 'right', lineHeight: 1.35 }}>{blocked ? 'Send disabled while a credential is present.' : 'Tokens stay on this device.'}</span>
                    <button className="ps-btn ps-btn-primary" style={{ height: 42, padding: '0 20px', fontSize: 14 }} disabled={blocked || empty} onClick={send}><Ic name="send" size={16} /> Send to Claude</button>
                  </>}
          </div>
        </div>
      </div>
    </window.FlowShell>
  );
}

// ── App ─────────────────────────────────────────────────────
const SEED_REVIEW = [
  { id: 'r1', span: 'Contoso', cat: 'customer', conf: 0.62, judge: false, ctx: 'Escalated by Contoso on the vendor bridge call this morning before the failover.' },
  { id: 'r2', span: 'Müller', cat: 'customer', conf: 0.71, judge: true, ctx: 'Ticket reassigned to A. Müller in the EU region for second-shift coverage.' },
  { id: 'r3', span: 'Globex Industrie', cat: 'customer', conf: 0.58, judge: false, ctx: 'Parent account Globex Industrie GmbH owns the affected tenant.' },
  { id: 'r4', span: '203.0.113.9', cat: 'ip', conf: 0.81, judge: true, ctx: 'Outbound NAT 203.0.113.9 appeared in the proxy log excerpt pasted above.' },
];
const SEED_VOCAB = [
  ...window.SAMPLE.tokens,
  { token: '{CUSTOMER_3}', cat: 'customer', real: 'Globex Industrie GmbH', count: 14 },
  { token: '{IP_2}', cat: 'ip', real: '192.168.40.11', count: 31 },
  { token: '{HOST_2}', cat: 'host', real: 'dc01.corp.globex.net', count: 9 },
  { token: '{EMAIL_2}', cat: 'email', real: 'ops@globex.example', count: 6 },
  { token: '{USER_2}', cat: 'user', real: 'CORP\\admin', count: 4 },
  { token: '{URL_2}', cat: 'url', real: 'https://vault.globex.example/secret', count: 2 },
];

function App() {
  const [theme, setThemeRaw] = useState(() => localStorage.getItem('ps-flow-theme') || 'dark');
  const setTheme = (t) => { setThemeRaw(t); try { localStorage.setItem('ps-flow-theme', t); } catch (e) {} };
  const [route, setRoute] = useState('scrub');
  const [text, setText] = useState(window.SAMPLE.raw);
  const [mode, setMode] = useState('enforce');
  const [customers, setCustomers] = useState(['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Soylent']);
  const [judgeOn, setJudgeOn] = useState(true);
  const [channel, setChannel] = useState('stable');
  const [review, setReview] = useState(SEED_REVIEW);
  const [stats, setStats] = useState({ confirmed: 37, allowed: 12 });
  const [vocab, setVocab] = useState(SEED_VOCAB);
  const [toasts, setToasts] = useState([]);

  const toast = (msg) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };

  const scrub = useMemo(() => {
    if (mode === 'disabled') return { runs: [{ t: 'text', v: text }], tokens: [], credentials: [] };
    return window.scrubText(text, { customers, mode });
  }, [text, customers, mode]);

  const reviewAction = (id, kind) => {
    const it = review.find((r) => r.id === id);
    setReview((r) => r.filter((x) => x.id !== id));
    if (kind === 'confirm') { setStats((s) => ({ ...s, confirmed: s.confirmed + 1 })); if (it) { setVocab((v) => [{ token: `{CUSTOMER_${v.filter((t) => t.cat === 'customer').length + 1}}`, cat: it.cat, real: it.span, count: 1 }, ...v]); toast(`Confirmed “${it.span}” — token minted`); } }
    else if (kind === 'allow') { setStats((s) => ({ ...s, allowed: s.allowed + 1 })); toast(`“${it ? it.span : ''}” added to allowlist`); }
    else toast('Ignored for now');
  };

  const shell = { theme, route, setRoute, setTheme };
  const common = { shell, reviewCount: review.length };

  return (
    <div style={{ height: '100%' }}>
      {route === 'scrub' && <ScrubScreen {...common} text={text} setText={setText} scrub={scrub} mode={mode} setMode={setMode} toast={toast} />}
      {route === 'review' && <window.ReviewScreen {...common} items={review} onAction={reviewAction} stats={stats} />}
      {route === 'vocab' && <window.VocabScreen {...common} rows={vocab} onForget={(tok) => { setVocab((v) => v.filter((r) => r.token !== tok)); toast('Forgotten — value removed from this device'); }} />}
      {route === 'settings' && <window.SettingsScreen {...common} mode={mode} setMode={setMode} judgeOn={judgeOn} setJudgeOn={setJudgeOn} channel={channel} setChannel={setChannel} customers={customers} addCustomer={(n) => { setCustomers((c) => c.includes(n) ? c : [...c, n]); toast(`“${n}” will now be tokenized`); }} removeCustomer={(n) => setCustomers((c) => c.filter((x) => x !== n))} />}

      {/* toasts */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 50 }}>
        {toasts.map((t) => (
          <div key={t.id} className={`ps-root ps-${theme} ps-acc-flow`} style={{ height: 'auto', width: 'auto' }}>
            <div className="ps-panel ps-row ps-gap8" style={{ padding: '10px 14px', fontSize: 12.5, fontWeight: 500, boxShadow: 'var(--shadow)', background: 'var(--surface)' }}>
              <window.Ic name="check" size={15} color="var(--acc)" /><span style={{ color: 'var(--text)' }}>{t.msg}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
