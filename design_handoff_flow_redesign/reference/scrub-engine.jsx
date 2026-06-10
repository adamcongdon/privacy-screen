// scrub-engine.jsx — a small, real PII tokenizer for the prototype.
// Deterministic regex layer (mirrors the project's taxonomy). Returns render
// runs, the token map, and any blocking credentials. Stable tokens: the same
// real value always maps to the same {CAT_n} within a pass.

(function () {
  const PATTERNS = [
    // [category, priority(lower=wins), regex]  — credentials first.
    ['credential', 0, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
    ['credential', 0, /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g],
    ['credential', 0, /\bBearer\s+[A-Za-z0-9._-]{8,}/g],
    ['credential', 0, /\b(?:password|passwd|api[_-]?key|secret|token)\s*[=:]\s*\S+/gi],
    ['email', 1, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
    ['url', 2, /\bhttps?:\/\/[^\s<>")]+/g],
    ['path', 3, /\\\\[\w.-]+\\[\w$.\\-]+/g],
    ['user', 4, /\b[A-Z][A-Z0-9]{1,}\\[A-Za-z0-9._-]+/g],
    ['account', 5, /\b(?:\d[ -]?){13,16}\b/g],
    ['ip', 6, /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g],
    ['phone', 7, /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}(?![\d.])/g],
    ['host', 8, /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi],
  ];

  function scrubText(text, opts) {
    opts = opts || {};
    const customers = opts.customers || [];
    const text0 = text || '';
    let spans = [];

    // customer names (literal, case-insensitive, whole-word-ish)
    customers.forEach((name) => {
      if (!name || !name.trim()) return;
      const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      let m;
      while ((m = re.exec(text0))) spans.push({ start: m.index, end: m.index + m[0].length, cat: 'customer', pri: 1.5, raw: m[0] });
    });

    PATTERNS.forEach(([cat, pri, re]) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text0))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        spans.push({ start: m.index, end: m.index + m[0].length, cat, pri, raw: m[0] });
      }
    });

    // resolve overlaps: sort by start, then priority; greedily keep non-overlapping
    spans.sort((a, b) => a.start - b.start || a.pri - b.pri || (b.end - b.start) - (a.end - a.start));
    const kept = [];
    let cursor = -1;
    for (const s of spans) {
      if (s.start >= cursor) { kept.push(s); cursor = s.end; }
    }

    // assign stable tokens
    const counters = {};
    const byReal = {};
    const tokens = [];
    const credentials = [];
    const runs = [];
    let last = 0;
    for (const s of kept) {
      if (s.start > last) runs.push({ t: 'text', v: text0.slice(last, s.start) });
      if (s.cat === 'credential') {
        credentials.push(s.raw);
        runs.push({ t: 'cred', v: s.raw });
      } else {
        const key = s.cat + '::' + s.raw.toLowerCase();
        let tok = byReal[key];
        if (!tok) {
          counters[s.cat] = (counters[s.cat] || 0) + 1;
          tok = '{' + (window.CATS[s.cat].label.toUpperCase().replace(/\s/g, '')) + '_' + counters[s.cat] + '}';
          byReal[key] = tok;
          tokens.push({ token: tok, cat: s.cat, real: s.raw, count: 1 });
        } else {
          const e = tokens.find((t) => t.token === tok); if (e) e.count++;
        }
        runs.push({ t: 'token', cat: s.cat, token: tok, real: s.raw });
      }
      last = s.end;
    }
    if (last < text0.length) runs.push({ t: 'text', v: text0.slice(last) });

    return { runs, tokens, credentials };
  }

  window.scrubText = scrubText;
})();
