// sample.jsx — shared realistic content + small shared bits for all directions.

const SAMPLE = {
  raw: `Customer Acme Corp opened a P1: their backup proxy srv-example01.acme.local (10.0.5.3) can't reach the repository at \\\\nas01\\backups.

Reported by Jane Doe — jane.doe@acme.local, +1 (555) 123-4567.
Repo console: https://internal.acme.com/repos/job-validate?id=88
Service account ACME\\svc-backup is failing auth.`,
  // tokenized runs: strings, or [cat, token] pairs rendered as pills
  scrubbed: [
    'Customer ', ['customer', '{CUSTOMER_1}'], ' opened a P1: their backup proxy ',
    ['host', '{HOST_1}'], ' (', ['ip', '{IP_1}'], ") can't reach the repository at ",
    ['path', '{PATH_1}'], '.\n\nReported by ', ['customer', '{CUSTOMER_2}'], ' — ',
    ['email', '{EMAIL_1}'], ', ', ['phone', '{PHONE_1}'], '.\nRepo console: ',
    ['url', '{URL_1}'], '\nService account ', ['user', '{USER_1}'], ' is failing auth.',
  ],
  tokens: [
    { token: '{CUSTOMER_1}', cat: 'customer', real: 'Acme Corp', count: 42 },
    { token: '{CUSTOMER_2}', cat: 'customer', real: 'Jane Doe', count: 7 },
    { token: '{HOST_1}', cat: 'host', real: 'srv-example01.acme.local', count: 18 },
    { token: '{IP_1}', cat: 'ip', real: '10.0.5.3', count: 23 },
    { token: '{PATH_1}', cat: 'path', real: '\\\\nas01\\backups', count: 5 },
    { token: '{EMAIL_1}', cat: 'email', real: 'jane.doe@acme.local', count: 11 },
    { token: '{PHONE_1}', cat: 'phone', real: '+1 (555) 123-4567', count: 3 },
    { token: '{URL_1}', cat: 'url', real: 'https://internal.acme.com/…', count: 4 },
    { token: '{USER_1}', cat: 'user', real: 'ACME\\svc-backup', count: 9 },
  ],
  review: [
    { span: 'Contoso', cat: 'customer', conf: 0.62, src: 'corp-entity heuristic',
      ctx: '…escalated by Contoso on the vendor bridge call…' },
    { span: 'Müller', cat: 'customer', conf: 0.71, src: 'judge: multilingual name',
      ctx: '…ticket reassigned to A. Müller in the EU region…', judge: true },
  ],
  reply: [
    "A few things to check on ", ['host', '{HOST_1}'],
    " before it can reach ", ['path', '{PATH_1}'], ":\n\n1. Confirm the proxy at ",
    ['ip', '{IP_1}'], " has the repository share mounted and that ",
    ['user', '{USER_1}'], " holds write permission.\n2. Have ",
    ['customer', '{CUSTOMER_2}'], " verify firewall rules between the proxy and the NAS.",
  ],
};

// Render a tokenized run array into text + Pills (uses window.Pill).
function Scrubbed({ runs, real = false, tokens = SAMPLE.tokens }) {
  const map = Object.fromEntries(tokens.map((t) => [t.token, t.real]));
  return runs.map((r, i) => {
    if (typeof r === 'string') return <span key={i}>{r}</span>;
    const [cat, tok] = r;
    if (real) return <span key={i} style={{ color: 'var(--acc)', fontFamily: 'var(--mono)' }}>{map[tok] || tok}</span>;
    return <window.Pill key={i} cat={cat}>{tok}</window.Pill>;
  });
}

// Shared theme toggle (visual only).
function ThemeToggle({ mode, vertical = false }) {
  return (
    <div className="ps-seg" role="group" aria-label="Color theme"
      style={vertical ? { flexDirection: 'column', padding: 3 } : null}>
      <button aria-pressed={mode === 'light'} title="Light"><window.Ic name="sun" size={15} /></button>
      <button aria-pressed={mode === 'dark'} title="Dark"><window.Ic name="moon" size={15} /></button>
    </div>
  );
}

Object.assign(window, { SAMPLE, Scrubbed, ThemeToggle });
