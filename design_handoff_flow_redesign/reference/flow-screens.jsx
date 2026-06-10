// flow-screens.jsx — interactive Review, Vocabulary, Settings for the prototype.
const { useState: _useState } = React;

// ── Review & triage ─────────────────────────────────────────
function ReviewScreen(props) {
  const { Ic } = window;
  const { items, onAction, stats } = props;
  const [filter, setFilter] = _useState('all');
  const shown = items.filter((it) => filter === 'all' || (filter === 'judge' ? it.judge : !it.judge));
  const Conf = ({ v }) => (
    <div className="ps-row ps-gap8" style={{ minWidth: 96 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
        <div style={{ width: `${v * 100}%`, height: '100%', background: v > 0.7 ? 'var(--ok)' : 'var(--warn)' }} />
      </div>
      <span className="ps-faint ps-mono" style={{ fontSize: 10.5 }}>{Math.round(v * 100)}%</span>
    </div>
  );
  const headerRight = <span className="ps-chip"><span className="ps-dot" style={{ background: 'var(--acc)' }} /> Judge on · scanning</span>;
  return (
    <window.FlowShell {...props.shell} reviewCount={items.length} title="Review queue"
      subtitle="Confirm, allow, or ignore spans the detectors weren't sure about." headerRight={headerRight} trust={false}>
      <div className="ps-row ps-gap16" style={{ minHeight: '100%', padding: '4px 24px 24px', alignItems: 'flex-start' }}>
        <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
          <div className="ps-row ps-gap8" style={{ marginBottom: 12 }}>
            <div className="ps-seg" role="group" aria-label="Filter">
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All · {items.length}</button>
              <button aria-pressed={filter === 'heuristic'} onClick={() => setFilter('heuristic')}><Ic name="filter" size={13} />Heuristic</button>
              <button aria-pressed={filter === 'judge'} onClick={() => setFilter('judge')}><Ic name="sparkle" size={13} />Judge</button>
            </div>
          </div>
          {shown.length === 0 ? (
            <div className="ps-panel ps-col" style={{ padding: 40, alignItems: 'center', gap: 10, textAlign: 'center' }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center' }}><Ic name="check" size={22} color="var(--ok)" /></div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Queue clear</span>
              <span className="ps-faint" style={{ fontSize: 12 }}>Nothing waiting on review. New low-confidence spans will land here.</span>
            </div>
          ) : (
            <div className="ps-col ps-gap10">
              {shown.map((it) => (
                <div key={it.id} className="ps-panel" style={{ padding: 15 }}>
                  <div className="ps-row" style={{ justifyContent: 'space-between', gap: 12 }}>
                    <div className="ps-row ps-gap10" style={{ minWidth: 0, flexWrap: 'wrap' }}>
                      <span className="ps-mono ps-h" style={{ fontSize: 15 }}>{it.span}</span>
                      <span className="ps-badge" style={it.judge ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent' } : null}>
                        {it.judge ? <><Ic name="sparkle" size={11} color="var(--acc)" /> judge</> : <><Ic name="filter" size={11} /> heuristic</>}
                      </span>
                      <span className="ps-chip" style={{ height: 22 }}><span style={{ width: 6, height: 6, borderRadius: 2, background: window.CATS[it.cat].color }} />→ {window.CATS[it.cat].label}</span>
                    </div>
                    <Conf v={it.conf} />
                  </div>
                  <p className="ps-dim ps-mono" style={{ fontSize: 11.5, lineHeight: 1.5, margin: '9px 0 12px' }}>{it.ctx}</p>
                  <div className="ps-row ps-gap8" style={{ flexWrap: 'wrap' }}>
                    <button className="ps-btn ps-btn-sm" style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }} onClick={() => onAction(it.id, 'confirm')}><Ic name="check" size={14} /> Confirm as {window.CATS[it.cat].label}</button>
                    <div className="ps-grow" />
                    <button className="ps-btn ps-btn-ghost ps-btn-sm" onClick={() => onAction(it.id, 'allow')}><Ic name="shield" size={14} /> Always allow</button>
                    <button className="ps-btn ps-btn-ghost ps-btn-sm" onClick={() => onAction(it.id, 'ignore')}><Ic name="x" size={14} /> Ignore</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="ps-col ps-gap14" style={{ width: 270, flex: 'none' }}>
          <div className="ps-panel" style={{ padding: 16 }}>
            <span className="ps-eyebrow">This session</span>
            <div className="ps-row ps-gap16" style={{ marginTop: 12 }}>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26 }}>{items.length}</span><span className="ps-faint" style={{ fontSize: 11 }}>pending</span></div>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26, color: 'var(--ok)' }}>{stats.confirmed}</span><span className="ps-faint" style={{ fontSize: 11 }}>confirmed</span></div>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26 }}>{stats.allowed}</span><span className="ps-faint" style={{ fontSize: 11 }}>allowed</span></div>
            </div>
          </div>
          <div className="ps-panel" style={{ padding: 16 }}>
            <span className="ps-eyebrow">What each action does</span>
            <div className="ps-col ps-gap10" style={{ marginTop: 12 }}>
              {[['check', 'var(--ok)', 'Confirm', 'Mints a permanent token — future runs auto-scrub it.'],
                ['shield', 'var(--acc)', 'Always allow', 'Never flag this string again.'],
                ['x', 'var(--text-faint)', 'Ignore', 'One-time pass; may resurface later.']].map(([ic, col, t, d]) => (
                <div key={t} className="ps-row ps-gap10" style={{ alignItems: 'flex-start' }}>
                  <Ic name={ic} size={15} color={col} style={{ marginTop: 1 }} />
                  <div className="ps-col"><span style={{ fontSize: 12.5, fontWeight: 600 }}>{t}</span><span className="ps-faint" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{d}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </window.FlowShell>
  );
}

// ── Vocabulary ──────────────────────────────────────────────
function VocabScreen(props) {
  const { Ic, Pill } = window;
  const { rows, onForget } = props;
  const [q, setQ] = _useState('');
  const [cat, setCat] = _useState('all');
  const [revealed, setRevealed] = _useState({});
  const cats = ['customer', 'ip', 'host', 'email', 'phone', 'url', 'user', 'path', 'account'];
  const filtered = rows.filter((r) =>
    (cat === 'all' || r.cat === cat) &&
    (q === '' || r.real.toLowerCase().includes(q.toLowerCase()) || r.token.toLowerCase().includes(q.toLowerCase())));
  const counts = cats.map((c) => [c, rows.filter((r) => r.cat === c).length]).filter(([, n]) => n);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const headerRight = (
    <>
      <div className="ps-search" style={{ width: 230 }}>
        <Ic name="search" size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values or tokens…"
          style={{ border: 0, background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none', width: '100%' }} />
      </div>
      <button className="ps-btn ps-btn-soft ps-btn-sm"><Ic name="download" size={14} /> Export</button>
    </>
  );
  return (
    <window.FlowShell {...props.shell} reviewCount={props.reviewCount} title="Vocabulary"
      subtitle="Every value you've tokenized — stored locally in SQLite, never synced." headerRight={headerRight} trust={false}>
      <div className="ps-row ps-gap16" style={{ minHeight: '100%', padding: '4px 24px 24px', alignItems: 'flex-start' }}>
        <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
          <div className="ps-row ps-gap6" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <button className="ps-chip" onClick={() => setCat('all')} style={cat === 'all' ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent', fontWeight: 600 } : null}>All · {rows.length}</button>
            {cats.map((c) => <button key={c} className="ps-chip" onClick={() => setCat(c)} style={cat === c ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent', fontWeight: 600 } : null}><span style={{ width: 7, height: 7, borderRadius: 2, background: window.CATS[c].color }} /> {window.CATS[c].label}</button>)}
          </div>
          <div className="ps-panel" style={{ overflow: 'hidden' }}>
            <div className="ps-row" style={{ padding: '9px 16px', borderBottom: '1px solid var(--border)', fontSize: 10.5, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              <span style={{ width: 150 }}>Token</span><span style={{ width: 96 }}>Category</span><span className="ps-grow">Real value</span><span style={{ width: 56, textAlign: 'right' }}>Uses</span><span style={{ width: 76 }} /></div>
            {filtered.length === 0 ? (
              <div className="ps-faint" style={{ padding: '26px 16px', fontSize: 12.5, textAlign: 'center' }}>No tokens match.</div>
            ) : filtered.map((r, i) => {
              const rev = revealed[r.token];
              return (
                <div key={r.token} className="ps-row" style={{ padding: '10px 16px', borderTop: i ? '1px solid var(--hairline)' : 0, fontSize: 12.5 }}>
                  <span style={{ width: 150 }}><Pill cat={r.cat} dot>{r.token}</Pill></span>
                  <span style={{ width: 96 }} className="ps-faint">{window.CATS[r.cat].label}</span>
                  <span className="ps-grow ps-mono" style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rev ? r.real : '•'.repeat(Math.min(14, r.real.length))}</span>
                  <span style={{ width: 56, textAlign: 'right' }} className="ps-faint ps-mono">{r.count}</span>
                  <span style={{ width: 76 }} className="ps-row ps-gap6">
                    <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label={rev ? 'Hide value' : 'Reveal value'} style={{ padding: '0 7px', marginLeft: 'auto' }} onClick={() => setRevealed((s) => ({ ...s, [r.token]: !s[r.token] }))}><Ic name={rev ? 'eyeoff' : 'eye'} size={13} /></button>
                    <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label="Forget" style={{ padding: '0 7px' }} onClick={() => onForget(r.token)}><Ic name="trash" size={13} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="ps-col ps-gap14" style={{ width: 240, flex: 'none' }}>
          <div className="ps-panel" style={{ padding: 16 }}>
            <span className="ps-eyebrow">By category</span>
            <div className="ps-col" style={{ marginTop: 12, gap: 9 }}>
              {counts.map(([c, n]) => (
                <div key={c} className="ps-col ps-gap4">
                  <div className="ps-row" style={{ justifyContent: 'space-between', fontSize: 12 }}><span className="ps-dim">{window.CATS[c].label}</span><span className="ps-faint ps-mono">{n}</span></div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}><div style={{ width: `${(n / max) * 100}%`, height: '100%', background: window.CATS[c].color, opacity: .8 }} /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="ps-panel ps-row ps-gap8" style={{ padding: 14 }}>
            <Ic name="lock" size={15} color="var(--ok)" />
            <span className="ps-dim" style={{ fontSize: 11.5, lineHeight: 1.4 }}>Values live only in <span className="ps-mono">~/.privacy-screen</span> on this device.</span>
          </div>
        </div>
      </div>
    </window.FlowShell>
  );
}

// ── Settings ────────────────────────────────────────────────
function SettingsScreen(props) {
  const { Ic } = window;
  const { mode, setMode, judgeOn, setJudgeOn, channel, setChannel, customers, addCustomer, removeCustomer } = props;
  const [draft, setDraft] = _useState('');
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
  const Radio = ({ id, title, desc, rec }) => {
    const on = mode === id;
    return (
      <button onClick={() => setMode(id)} className="ps-row ps-gap10" style={{ width: '100%', textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer',
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
  };
  const add = () => { if (draft.trim()) { addCustomer(draft.trim()); setDraft(''); } };
  return (
    <window.FlowShell {...props.shell} reviewCount={props.reviewCount} title="Settings"
      subtitle="Modes, the local LLM judge, updates, and your customer vocabulary." trust={false}>
      <div className="ps-row ps-gap16" style={{ padding: '4px 24px 24px', alignItems: 'flex-start' }}>
        <div className="ps-col ps-gap16 ps-grow" style={{ minWidth: 0 }}>
          <Card icon="bolt" title="Screening mode" accent>
            <div className="ps-col ps-gap8">
              <Radio id="observe" title="Observe" desc="Detect and log only — nothing is blocked or mutated." />
              <Radio id="enforce" title="Enforce" desc="Block credentials and replace PII with tokens before send." rec />
              <Radio id="disabled" title="Disabled" desc="Emergency bypass — text passes through untouched." />
            </div>
          </Card>
          <Card icon="user" title="Customer names" desc="Names added here are always tokenized as {CUSTOMER}. Try adding one, then revisit Scrub.">
            <div className="ps-row" style={{ flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
              {customers.length === 0 && <span className="ps-faint" style={{ fontSize: 12 }}>No names yet.</span>}
              {customers.map((n) => (
                <span key={n} className="ps-chip" style={{ height: 28 }}>{n}<button onClick={() => removeCustomer(n)} aria-label={`Remove ${n}`} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 0 }}><Ic name="x" size={12} /></button></span>
              ))}
            </div>
            <div className="ps-row ps-gap8">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="ps-input" placeholder="Add a name…" style={{ flex: 1 }} />
              <button className="ps-btn ps-btn-soft ps-btn-sm" onClick={add}><Ic name="plus" size={14} /> Add</button>
            </div>
          </Card>
        </div>
        <div className="ps-col ps-gap16 ps-grow" style={{ minWidth: 0 }}>
          <Card icon="sparkle" title="Local LLM judge" accent>
            <div className="ps-inset" style={{ padding: 13, marginBottom: 12 }}>
              <div className="ps-row" style={{ justifyContent: 'space-between' }}>
                <div className="ps-row ps-gap10">
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--surface-3)', display: 'grid', placeItems: 'center' }}><Ic name="sparkle" size={17} color="var(--acc)" /></div>
                  <div className="ps-col"><span style={{ fontSize: 13, fontWeight: 600 }}>qwen2.5-1.5b</span><span className="ps-faint" style={{ fontSize: 11 }}>1.0 GB · Apache-2.0 · 29 languages</span></div>
                </div>
                <span className="ps-badge" style={{ background: 'var(--ok-tint)', color: 'var(--ok)', borderColor: 'transparent' }}><Ic name="check" size={11} color="var(--ok)" /> Installed</span>
              </div>
            </div>
            <div className="ps-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="ps-col"><span style={{ fontSize: 13, fontWeight: 600 }}>Enable judge</span><span className="ps-faint" style={{ fontSize: 11.5 }}>Second-pass review of already-scrubbed text. Runs fully local.</span></div>
              <button className="ps-toggle" role="switch" aria-checked={judgeOn} aria-label="Enable judge" onClick={() => setJudgeOn(!judgeOn)} />
            </div>
          </Card>
          <Card icon="refresh" title="Updates" desc="Opt-in. No telemetry; SHA-256 verified before any swap.">
            <div className="ps-row ps-gap10" style={{ marginBottom: 12 }}>
              <div className="ps-seg" role="group" aria-label="Channel">
                {['off', 'stable', 'beta'].map((c) => <button key={c} aria-pressed={channel === c} onClick={() => setChannel(c)} style={{ textTransform: 'capitalize' }}>{c}</button>)}
              </div>
              <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="refresh" size={13} /> Check now</button>
            </div>
            <div className="ps-row ps-gap8" style={{ fontSize: 12 }}><span className="ps-dim">On <span className="ps-mono">v1.4.0</span></span><span className="ps-faint">·</span><span style={{ color: 'var(--ok)' }}>Up to date</span></div>
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

Object.assign(window, { ReviewScreen, VocabScreen, SettingsScreen });
