// screens.jsx — supporting screens in the Flow shell:
// Review & triage, Vocabulary (token map), Settings.

// ── Review & triage ─────────────────────────────────────────
function ReviewScreen({ mode = 'dark' }) {
  const { Ic, Pill } = window;
  const items = [
    { span: 'Contoso', cat: 'customer', conf: 0.62, src: 'heuristic', judge: false, ctx: 'Escalated by Contoso on the vendor bridge call this morning before the failover.' },
    { span: 'Müller', cat: 'customer', conf: 0.71, src: 'judge', judge: true, ctx: 'Ticket reassigned to A. Müller in the EU region for second-shift coverage.' },
    { span: 'Globex Industrie', cat: 'customer', conf: 0.58, src: 'heuristic', judge: false, ctx: 'Parent account Globex Industrie GmbH owns the affected tenant.' },
    { span: '203.0.113.9', cat: 'ip', conf: 0.81, src: 'judge', judge: true, ctx: 'Outbound NAT 203.0.113.9 appeared in the proxy log excerpt pasted above.' },
  ];
  const Conf = ({ v }) => (
    <div className="ps-row ps-gap8" style={{ minWidth: 92 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
        <div style={{ width: `${v * 100}%`, height: '100%', background: v > 0.7 ? 'var(--ok)' : 'var(--warn)' }} />
      </div>
      <span className="ps-faint ps-mono" style={{ fontSize: 10.5 }}>{Math.round(v * 100)}%</span>
    </div>
  );

  const right = <span className="ps-chip"><span className="ps-dot" style={{ background: 'var(--acc)' }} /> Judge on · scanning</span>;

  return (
    <window.FlowShell mode={mode} active="review" title="Review queue" subtitle="Confirm, allow, or ignore spans the detectors weren't sure about." headerRight={right} trust={false}>
      <div className="ps-row ps-gap16" style={{ height: '100%', padding: '4px 22px 0', alignItems: 'stretch' }}>
        {/* list */}
        <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
          <div className="ps-row ps-gap8" style={{ marginBottom: 12 }}>
            <div className="ps-seg" role="group" aria-label="Filter">
              <button aria-pressed="true">All · 4</button>
              <button aria-pressed="false"><Ic name="filter" size={13} />Heuristic</button>
              <button aria-pressed="false"><Ic name="sparkle" size={13} />Judge</button>
            </div>
          </div>
          <div className="ps-col ps-gap10" style={{ overflow: 'hidden' }}>
            {items.map((it) => (
              <div key={it.span} className="ps-panel" style={{ padding: 15 }}>
                <div className="ps-row" style={{ justifyContent: 'space-between', gap: 12 }}>
                  <div className="ps-row ps-gap10" style={{ minWidth: 0 }}>
                    <span className="ps-mono ps-h" style={{ fontSize: 15 }}>{it.span}</span>
                    <span className="ps-badge" style={it.judge ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent' } : null}>
                      {it.judge ? <><Ic name="sparkle" size={11} color="var(--acc)" /> judge</> : <><Ic name="filter" size={11} /> heuristic</>}
                    </span>
                    <span className="ps-chip" style={{ height: 22 }}><span className="ps-pilldot" style={{ width: 6, height: 6, borderRadius: 2, background: window.CATS[it.cat].color }} />→ {window.CATS[it.cat].label}</span>
                  </div>
                  <Conf v={it.conf} />
                </div>
                <p className="ps-dim ps-mono" style={{ fontSize: 11.5, lineHeight: 1.5, margin: '9px 0 12px' }}>{it.ctx}</p>
                <div className="ps-row ps-gap8">
                  <button className="ps-btn ps-btn-sm" style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}><Ic name="check" size={14} /> Confirm as {window.CATS[it.cat].label}</button>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="chevdown" size={13} /></button>
                  <div className="ps-grow" />
                  <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="shield" size={14} /> Always allow</button>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm"><Ic name="x" size={14} /> Ignore</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* side rail */}
        <div className="ps-col ps-gap14" style={{ width: 270, flex: 'none' }}>
          <div className="ps-panel" style={{ padding: 16 }}>
            <span className="ps-eyebrow">This session</span>
            <div className="ps-row ps-gap16" style={{ marginTop: 12 }}>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26 }}>4</span><span className="ps-faint" style={{ fontSize: 11 }}>pending</span></div>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26, color: 'var(--ok)' }}>37</span><span className="ps-faint" style={{ fontSize: 11 }}>confirmed</span></div>
              <div className="ps-col"><span className="ps-h" style={{ fontSize: 26 }}>12</span><span className="ps-faint" style={{ fontSize: 11 }}>allowed</span></div>
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
          <div className="ps-panel" style={{ padding: 16, borderStyle: 'dashed' }}>
            <div className="ps-row ps-gap8"><Ic name="bolt" size={15} color="var(--acc)" /><span style={{ fontSize: 12.5, fontWeight: 600 }}>Pattern suggestion</span></div>
            <p className="ps-faint" style={{ fontSize: 11.5, lineHeight: 1.5, margin: '8px 0 10px' }}>You've confirmed 3 values ending in <span className="ps-mono">GmbH</span>. Add a rule to auto-tokenize them?</p>
            <button className="ps-btn ps-btn-soft ps-btn-sm" style={{ width: '100%' }}><Ic name="plus" size={13} /> Create rule</button>
          </div>
        </div>
      </div>
    </window.FlowShell>
  );
}

// ── Vocabulary / token map ──────────────────────────────────
function VocabScreen({ mode = 'dark' }) {
  const { Ic, Pill, SAMPLE } = window;
  const rows = [
    ...SAMPLE.tokens,
    { token: '{CUSTOMER_3}', cat: 'customer', real: 'Globex Industrie GmbH', count: 14 },
    { token: '{IP_2}', cat: 'ip', real: '192.168.40.11', count: 31 },
    { token: '{HOST_2}', cat: 'host', real: 'dc01.corp.globex.net', count: 9 },
    { token: '{EMAIL_2}', cat: 'email', real: 'ops@globex.example', count: 6 },
  ];
  const cats = ['customer', 'ip', 'host', 'email', 'phone', 'url', 'user', 'path', 'account'];
  const right = (
    <>
      <div className="ps-search" style={{ width: 220 }}><Ic name="search" size={15} /> Search values or tokens…</div>
      <button className="ps-btn ps-btn-soft ps-btn-sm"><Ic name="download" size={14} /> Export</button>
    </>
  );
  return (
    <window.FlowShell mode={mode} active="vocab" title="Vocabulary" subtitle="Every value you've tokenized — stored locally in SQLite, never synced." headerRight={right} trust={false}>
      <div className="ps-row ps-gap16" style={{ height: '100%', padding: '4px 22px 0', alignItems: 'stretch' }}>
        <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
          <div className="ps-row ps-gap6" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <button className="ps-chip" style={{ background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent', fontWeight: 600 }}>All · 142</button>
            {cats.map((c) => <button key={c} className="ps-chip"><span style={{ width: 7, height: 7, borderRadius: 2, background: window.CATS[c].color }} /> {window.CATS[c].label}</button>)}
          </div>
          <div className="ps-panel" style={{ overflow: 'hidden' }}>
            <div className="ps-row" style={{ padding: '9px 16px', borderBottom: '1px solid var(--border)', fontSize: 10.5, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              <span style={{ width: 150 }}>Token</span><span style={{ width: 96 }}>Category</span><span className="ps-grow">Real value</span><span style={{ width: 56, textAlign: 'right' }}>Uses</span><span style={{ width: 84, textAlign: 'right' }} /></div>
            {rows.map((r, i) => (
              <div key={r.token} className="ps-row" style={{ padding: '10px 16px', borderTop: i ? '1px solid var(--hairline)' : 0, fontSize: 12.5 }}>
                <span style={{ width: 150 }}><Pill cat={r.cat} dot>{r.token}</Pill></span>
                <span style={{ width: 96 }} className="ps-faint">{window.CATS[r.cat].label}</span>
                <span className="ps-grow ps-mono" style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i % 3 === 1 ? '•••••••••••••' : r.real}</span>
                <span style={{ width: 56, textAlign: 'right' }} className="ps-faint ps-mono">{r.count}</span>
                <span style={{ width: 84 }} className="ps-row ps-gap6" >
                  <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label="Reveal value" style={{ padding: '0 7px', marginLeft: 'auto' }}><Ic name={i % 3 === 1 ? 'eyeoff' : 'eye'} size={13} /></button>
                  <button className="ps-btn ps-btn-ghost ps-btn-sm" aria-label="Forget" style={{ padding: '0 7px' }}><Ic name="trash" size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="ps-col ps-gap14" style={{ width: 240, flex: 'none' }}>
          <div className="ps-panel" style={{ padding: 16 }}>
            <span className="ps-eyebrow">By category</span>
            <div className="ps-col ps-gap9" style={{ marginTop: 12, gap: 9 }}>
              {[['customer', 38], ['ip', 27], ['host', 24], ['email', 19], ['url', 14], ['user', 11], ['phone', 9]].map(([c, n]) => (
                <div key={c} className="ps-col ps-gap4">
                  <div className="ps-row" style={{ justifyContent: 'space-between', fontSize: 12 }}><span className="ps-dim">{window.CATS[c].label}</span><span className="ps-faint ps-mono">{n}</span></div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}><div style={{ width: `${(n / 38) * 100}%`, height: '100%', background: window.CATS[c].color, opacity: .8 }} /></div>
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

window.ReviewScreen = ReviewScreen;
window.VocabScreen = VocabScreen;
