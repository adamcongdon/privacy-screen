// chat.jsx — Direction 3 · "Chat"
// Conversation-native take that sells the chat-replacement roadmap: a thread
// in the middle, a live Privacy Inspector on the right showing exactly what
// Claude sees. Accent: violet.

function ChatWorkspace({ mode = 'dark' }) {
  const { Ic, Pill, SAMPLE } = window;
  const map = Object.fromEntries(SAMPLE.tokens.map((t) => [t.token, t.real]));

  // Deanonymized display: real values shown, each protected span underlined in
  // its category color (hover = the token Claude actually received).
  const Deanon = ({ runs }) => runs.map((r, i) => {
    if (typeof r === 'string') return <span key={i}>{r}</span>;
    const [cat, tok] = r;
    const c = window.CATS[cat].color;
    return <span key={i} title={`sent as ${tok}`} style={{ borderBottom: `1.5px dotted ${c}`, paddingBottom: 1 }}>{map[tok] || tok}</span>;
  });

  const Bubble = ({ role, children, caption }) => (
    <div className="ps-col ps-gap6" style={{ maxWidth: 560 }}>
      <div className="ps-row ps-gap8">
        <div style={{ width: 24, height: 24, borderRadius: 7, flex: 'none', display: 'grid', placeItems: 'center',
          background: role === 'user' ? 'var(--surface-3)' : 'var(--acc)' }}>
          {role === 'user' ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)' }}>AC</span> : <Ic name="sparkle" size={14} color="var(--acc-ink)" />}
        </div>
        <span className="ps-eyebrow" style={{ color: role === 'user' ? 'var(--text-faint)' : 'var(--acc)' }}>{role === 'user' ? 'You' : 'Claude'}</span>
      </div>
      <div style={{ marginLeft: 32 }}>
        <div className="ps-inset" style={{ padding: '12px 15px', fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap',
          background: role === 'user' ? 'var(--surface-2)' : 'var(--surface)', color: 'var(--text)' }}>{children}</div>
        {caption && <div className="ps-row ps-gap6 ps-faint" style={{ fontSize: 11, marginTop: 6 }}><Ic name="lock" size={12} /> {caption}</div>}
      </div>
    </div>
  );

  return (
    <div className={`ps-root ps-${mode} ps-acc-chat`} style={{ display: 'flex' }}>
      {/* rail */}
      <div className="ps-col" style={{ width: 70, flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--surface)', padding: '12px 8px', gap: 4 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--acc)', display: 'grid', placeItems: 'center', margin: '2px auto 10px' }}><Ic name="shield" size={21} color="var(--acc-ink)" sw={1.9} /></div>
        {[['chat', 'Chat', true], ['scrub', 'Scrub', false], ['flag', 'Review', false], ['book', 'Vocab', false]].map(([ic, lb, on]) => (
          <button key={lb} className="ps-rail-item" aria-current={on ? 'page' : undefined}><Ic name={ic} size={20} />{lb}</button>
        ))}
        <div className="ps-grow" />
        <window.ThemeToggle mode={mode} vertical />
        <button className="ps-rail-item" aria-label="Settings"><Ic name="settings" size={19} />Settings</button>
      </div>

      {/* conversation */}
      <div className="ps-col ps-grow" style={{ minWidth: 0 }}>
        <div className="ps-row" style={{ justifyContent: 'space-between', padding: '13px 20px', borderBottom: '1px solid var(--border)' }}>
          <div className="ps-col" style={{ gap: 2 }}>
            <span className="ps-h" style={{ fontSize: 15 }}>Acme backup proxy — P1</span>
            <span className="ps-faint" style={{ fontSize: 11.5 }}>9 values protected in this thread</span>
          </div>
          <div className="ps-row ps-gap10">
            <span className="ps-chip"><span className="ps-dot" style={{ background: 'var(--acc)' }} /> Enforce</span>
            <div className="ps-seg" role="group" aria-label="View"><button aria-pressed="true"><Ic name="eye" size={13} />Real values</button><button aria-pressed="false"><Ic name="scrub" size={13} />Wire payload</button></div>
          </div>
        </div>

        <div className="ps-col ps-gap20 ps-grow" style={{ padding: '20px 22px', overflow: 'hidden' }}>
          <Bubble role="user" caption="9 values tokenized before this message was sent">
            <Deanon runs={SAMPLE.scrubbed} />
          </Bubble>
          <Bubble role="assistant" caption="Deanonymized for you — Claude only ever saw the tokens">
            <Deanon runs={SAMPLE.reply} />
          </Bubble>
        </div>

        {/* composer */}
        <div style={{ padding: '0 22px 18px' }}>
          <div className="ps-panel" style={{ padding: 12 }}>
            <div className="ps-mono ps-dim" style={{ fontSize: 13, padding: '2px 4px 10px' }}>Can you draft the resolution note for {map['{CUSTOMER_2}']}?<span style={{ color: 'var(--acc)' }}>▍</span></div>
            <div className="ps-row" style={{ justifyContent: 'space-between' }}>
              <span className="ps-row ps-gap6 ps-faint" style={{ fontSize: 11.5 }}><Ic name="shield" size={13} color="var(--acc)" /> 1 value will be tokenized before send</span>
              <button className="ps-btn ps-btn-primary ps-btn-sm"><Ic name="send" size={14} /> Send</button>
            </div>
          </div>
        </div>
      </div>

      {/* privacy inspector */}
      <div className="ps-col" style={{ width: 296, flex: 'none', borderLeft: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div className="ps-row ps-gap8" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Ic name="lock" size={15} color="var(--acc)" /><span className="ps-h" style={{ fontSize: 13.5 }}>Privacy inspector</span>
        </div>
        <div className="ps-col ps-gap8" style={{ padding: 14 }}>
          <span className="ps-eyebrow">What Claude sees · 9 tokens</span>
          <div className="ps-col ps-gap6">
            {SAMPLE.tokens.slice(0, 6).map((t) => (
              <div key={t.token} className="ps-row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <Pill cat={t.cat} dot>{t.token}</Pill>
                <span className="ps-faint ps-mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120, textAlign: 'right' }}>{t.real}</span>
              </div>
            ))}
            <button className="ps-btn ps-btn-ghost ps-btn-sm" style={{ marginTop: 2 }}>Show all 9</button>
          </div>
        </div>
        <div className="ps-divider" />
        <div className="ps-col ps-gap8" style={{ padding: 14 }}>
          <div className="ps-row" style={{ justifyContent: 'space-between' }}><span className="ps-eyebrow" style={{ color: 'var(--warn)' }}>Needs review</span><span className="ps-badge" style={{ background: 'var(--warn-tint)', color: 'var(--warn)', borderColor: 'transparent' }}>1</span></div>
          <div className="ps-inset" style={{ padding: 10 }}>
            <div className="ps-row ps-gap6" style={{ marginBottom: 5 }}><span className="ps-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>Müller</span><span className="ps-faint" style={{ fontSize: 10 }}>· judge</span></div>
            <div className="ps-row ps-gap6"><button className="ps-btn ps-btn-sm" style={{ flex: 1, background: 'var(--ok-tint)', color: 'var(--ok)' }}>Confirm</button><button className="ps-btn ps-btn-ghost ps-btn-sm" style={{ flex: 1 }}>Ignore</button></div>
          </div>
        </div>
        <div className="ps-grow" />
        <div className="ps-row ps-gap8" style={{ padding: 14, borderTop: '1px solid var(--border)', color: 'var(--ok)', fontSize: 11.5 }}>
          <Ic name="check" size={13} color="var(--ok)" /> 0 credentials · 0 leaks this thread
        </div>
      </div>
    </div>
  );
}
window.ChatWorkspace = ChatWorkspace;
