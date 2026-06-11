/**
 * xlsx-scrubber tests — Issue #23 data layer.
 *
 * Builds workbooks in-memory via `exceljs` (no binary fixtures), runs
 * `scrubXlsx`, then loads the returned buffer back through `exceljs` to
 * assert on the scrubbed cell values + summary.
 *
 * Test data is invented — never a real email, phone, or person.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import ExcelJS from 'exceljs';
import { ScrubMap } from '../src/scrub-map';
import { scrubXlsx, type CommitOverrides, type XlsxConfig } from '../src/xlsx-scrubber';
import type { PrivacyConfig } from '../src/config';

// ── Test config baseline ─────────────────────────────────────────────────────

const baseCfg: PrivacyConfig = {
  fqdn_allowlist_extra: [],
  customer_names: [],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  skip_scrub_fields: {},
  update_channel: 'off',
  update_manifest_url: 'https://example.invalid/manifest.json',
  feedback_relay_url: 'https://privacy-screen-feedback.example.workers.dev',
  llm_validate: {
    enabled: false,
    model_path: null,
    runtime: 'llama-server',
    endpoint: null,
    max_tokens: 256,
    timeout_ms: 2500,
    min_confidence: 0.6,
  },
  hook: { auto_approve_clean: false },
  xlsx: { columnRules: [], autoDetect: true },
};

const defaultXlsxCfg: XlsxConfig = { columnRules: [], autoDetect: true };

// ── Fixture builders ─────────────────────────────────────────────────────────

/**
 * Build a 2-sheet workbook in memory:
 *   Sheet1: Email | Phone | Notes | ID
 *   Sheet2: Name (PersonName via heuristic) | Address
 */
async function buildDemoWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const s1 = wb.addWorksheet('Sheet1');
  s1.addRow(['Email', 'Phone', 'Notes', 'ID']);
  s1.addRow([
    'alpha@invented-domain.test',
    '(555) 010-2001',
    'reach alpha@invented-domain.test before EOD',
    1001,
  ]);
  s1.addRow([
    'bravo@invented-domain.test',
    '(555) 010-2002',
    'no follow-up needed',
    1002,
  ]);
  s1.addRow([
    'charlie@invented-domain.test',
    '(555) 010-2003',
    'see also delta@invented-domain.test',
    1003,
  ]);

  const s2 = wb.addWorksheet('Sheet2');
  s2.addRow(['Name', 'Address']);
  s2.addRow(['Alex Example', '123 Elm Street']);
  s2.addRow(['Pat Specimen', '456 Oak Avenue']);

  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Build a workbook with a non-heuristic header to exercise columnRules. */
async function buildCustomMailWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('Sheet1');
  s.addRow(['Customer Mail', 'Misc']);
  s.addRow(['echo@invented-domain.test', 'misc-1']);
  s.addRow(['foxtrot@invented-domain.test', 'misc-2']);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Build a workbook with some empty cells. */
async function buildSparseWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('Sheet1');
  s.addRow(['Email', 'Phone']);
  s.addRow(['golf@invented-domain.test', null]);
  s.addRow([null, '(555) 010-2050']);
  s.addRow([null, null]);
  s.addRow(['hotel@invented-domain.test', '(555) 010-2051']);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Load a Buffer back into a workbook for assertion. */
async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);
  return wb;
}

function readCell(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const c = ws.getRow(row).getCell(col);
  return c.value === null || c.value === undefined ? '' : String(c.text);
}

// ── Sanity: fixture builds round-trip cleanly ───────────────────────────────

describe('xlsx test fixtures', () => {
  let demoBuf: Buffer;
  beforeAll(async () => { demoBuf = await buildDemoWorkbook(); });

  test('demo workbook builds and loads with 2 sheets', async () => {
    const wb = await loadWorkbook(demoBuf);
    expect(wb.worksheets.length).toBe(2);
    expect(wb.getWorksheet('Sheet1')?.actualRowCount).toBe(4); // header + 3
    expect(wb.getWorksheet('Sheet2')?.actualRowCount).toBe(3); // header + 2
  });
});

// ── scrubXlsx — round-trip with autoDetect ───────────────────────────────────

describe('scrubXlsx — round-trip with auto-detected columns', () => {
  let demoBuf: Buffer;
  beforeAll(async () => { demoBuf = await buildDemoWorkbook(); });

  test('emails / phones / notes scrub; ID untouched', async () => {
    const map = new ScrubMap();
    const result = await scrubXlsx(
      demoBuf,
      map,
      null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
    );

    expect(result.scrubbedBuffer).toBeInstanceOf(Buffer);
    expect(result.scrubbedBuffer.length).toBeGreaterThan(0);

    const wb = await loadWorkbook(result.scrubbedBuffer);
    expect(wb.worksheets.length).toBe(2);

    const s1 = wb.getWorksheet('Sheet1');
    expect(s1).toBeDefined();
    if (!s1) return;

    // Email column (col 1, rows 2..4) — should be {EMAIL...} tokens
    for (let row = 2; row <= 4; row += 1) {
      const v = readCell(s1, row, 1);
      expect(v).toMatch(/^\{EMAIL(_\d+)?\}$/);
    }
    // Distinct emails → distinct tokens
    const e1 = readCell(s1, 2, 1);
    const e2 = readCell(s1, 3, 1);
    const e3 = readCell(s1, 4, 1);
    expect(new Set([e1, e2, e3]).size).toBe(3);

    // Phone column (col 2, rows 2..4) — should be {PHONE...} tokens
    for (let row = 2; row <= 4; row += 1) {
      const v = readCell(s1, row, 2);
      expect(v).toMatch(/^\{PHONE(_\d+)?\}$/);
    }

    // Notes column (col 3) — emails inline tokenized via regex fallback
    const n1 = readCell(s1, 2, 3);
    expect(n1).not.toContain('alpha@invented-domain.test');
    expect(n1).toMatch(/\{EMAIL(_\d+)?\}/);

    const n2 = readCell(s1, 3, 3);
    expect(n2).toBe('no follow-up needed'); // unchanged

    const n3 = readCell(s1, 4, 3);
    expect(n3).not.toContain('delta@invented-domain.test');
    expect(n3).toMatch(/\{EMAIL(_\d+)?\}/);

    // ID column (col 4) — autoDetect doesn't match a numeric column,
    // and the cells are numbers (not strings), so the regex fallback
    // skips them. Values preserved as numbers.
    for (let row = 2; row <= 4; row += 1) {
      const c = s1.getRow(row).getCell(4);
      expect(typeof c.value).toBe('number');
    }
    expect(s1.getRow(2).getCell(4).value).toBe(1001);
    expect(s1.getRow(3).getCell(4).value).toBe(1002);
    expect(s1.getRow(4).getCell(4).value).toBe(1003);

    // Summary
    expect(result.summary.sheets).toBe(2);
    // Sheet1 has 3 data rows, Sheet2 has 2 → 5 rows total.
    expect(result.summary.rows).toBe(5);
    // 3 emails + 3 phones (Sheet1) + 2 notes-with-email = 8
    // plus Sheet2 force-mints (Name × 2, Address × 2) = 4 → at least 9.
    expect(result.summary.cellsScrubbed).toBeGreaterThanOrEqual(9);

    expect(result.summary.columnsResolved['Sheet1::Email']).toBe('Email');
    expect(result.summary.columnsResolved['Sheet1::Phone']).toBe('Phone');
    // Notes is unresolved → regex fallback label.
    expect(result.summary.columnsResolved['Sheet1::Notes']).toBe('regex');
    expect(result.summary.columnsResolved['Sheet1::ID']).toBe('regex');
    expect(result.summary.columnsResolved['Sheet2::Name']).toBe('PersonName');
    expect(result.summary.columnsResolved['Sheet2::Address']).toBe('StreetAddress');
  });

  test('Sheet2 Name + Address force-mint produces PERSON / ADDR tokens', async () => {
    const map = new ScrubMap();
    const result = await scrubXlsx(
      demoBuf,
      map,
      null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
    );

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s2 = wb.getWorksheet('Sheet2');
    expect(s2).toBeDefined();
    if (!s2) return;

    for (let row = 2; row <= 3; row += 1) {
      const name = readCell(s2, row, 1);
      const addr = readCell(s2, row, 2);
      expect(name).toMatch(/^\{PERSON(_\d+)?\}$/);
      expect(addr).toMatch(/^\{ADDR(_\d+)?\}$/);
    }
  });
});

// ── scrubXlsx — explicit columnRules ─────────────────────────────────────────

describe('scrubXlsx — explicit columnRules', () => {
  test('custom-named "Customer Mail" header tokenizes via rule', async () => {
    const buf = await buildCustomMailWorkbook();
    const map = new ScrubMap();
    const xlsxCfg: XlsxConfig = {
      autoDetect: false, // disable heuristic so we know the rule fired
      columnRules: [{ header: 'Customer Mail', pattern: 'Email' }],
    };

    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: xlsxCfg, baseConfig: baseCfg },
    );

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s = wb.getWorksheet('Sheet1');
    expect(s).toBeDefined();
    if (!s) return;

    expect(readCell(s, 2, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);
    expect(readCell(s, 3, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);
    // Misc column untouched (string passes through regex fallback;
    // "misc-1" / "misc-2" have no PII signal).
    expect(readCell(s, 2, 2)).toBe('misc-1');
    expect(readCell(s, 3, 2)).toBe('misc-2');
    expect(result.summary.columnsResolved['Sheet1::Customer Mail']).toBe('Email');
  });

  test('headerRegex form matches case-insensitively', async () => {
    const buf = await buildCustomMailWorkbook();
    const map = new ScrubMap();
    const xlsxCfg: XlsxConfig = {
      autoDetect: false,
      columnRules: [{ headerRegex: 'customer.*mail', pattern: 'Email' }],
    };

    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: xlsxCfg, baseConfig: baseCfg },
    );

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s = wb.getWorksheet('Sheet1');
    expect(s).toBeDefined();
    if (!s) return;
    expect(readCell(s, 2, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);
  });
});

// ── scrubXlsx — overrides ────────────────────────────────────────────────────

describe('scrubXlsx — per-upload overrides', () => {
  test('Notes set to skip leaves cells untouched', async () => {
    const buf = await buildDemoWorkbook();
    const map = new ScrubMap();
    const overrides: CommitOverrides = {
      Sheet1: { Notes: { pattern: 'skip' } },
    };

    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
      overrides,
    );

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s1 = wb.getWorksheet('Sheet1');
    expect(s1).toBeDefined();
    if (!s1) return;

    // Notes column should be exactly the original text.
    expect(readCell(s1, 2, 3)).toBe('reach alpha@invented-domain.test before EOD');
    expect(readCell(s1, 3, 3)).toBe('no follow-up needed');
    expect(readCell(s1, 4, 3)).toBe('see also delta@invented-domain.test');

    // Email column still tokenized.
    expect(readCell(s1, 2, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);

    expect(result.summary.columnsResolved['Sheet1::Notes']).toBe('skip');
  });

  test('Email column overridden to skip is preserved verbatim', async () => {
    const buf = await buildDemoWorkbook();
    const map = new ScrubMap();
    const overrides: CommitOverrides = {
      Sheet1: { Email: { pattern: 'skip' } },
    };
    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
      overrides,
    );
    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s1 = wb.getWorksheet('Sheet1');
    expect(s1).toBeDefined();
    if (!s1) return;
    expect(readCell(s1, 2, 1)).toBe('alpha@invented-domain.test');
    expect(result.summary.columnsResolved['Sheet1::Email']).toBe('skip');
  });

  // Issue #39 — custom column labels.
  test('custom-label override force-mints with the user-supplied token type', async () => {
    const buf = await buildDemoWorkbook();
    const map = new ScrubMap();
    const overrides: CommitOverrides = {
      Sheet1: { Notes: { pattern: 'custom', label: 'JobName' } },
    };
    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
      overrides,
    );
    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s1 = wb.getWorksheet('Sheet1');
    expect(s1).toBeDefined();
    if (!s1) return;

    // Every Notes cell becomes a {JOBNAME}/{JOBNAME_N} token.
    expect(readCell(s1, 2, 3)).toMatch(/^\{JOBNAME(_\d+)?\}$/);
    expect(readCell(s1, 3, 3)).toMatch(/^\{JOBNAME(_\d+)?\}$/);
    expect(readCell(s1, 4, 3)).toMatch(/^\{JOBNAME(_\d+)?\}$/);

    // Different cell contents must mint distinct tokens.
    const n2 = readCell(s1, 2, 3);
    const n3 = readCell(s1, 3, 3);
    expect(n2).not.toBe(n3);

    // Summary records the custom-prefixed label.
    expect(result.summary.columnsResolved['Sheet1::Notes']).toBe('custom:JOBNAME');
  });

  test('repeated cell value under custom label reuses the same token', async () => {
    const buf = await buildDemoWorkbook();
    const map = new ScrubMap();
    // The demo workbook has two identical adjacent cells in Notes? Use a
    // direct map assertion instead — mint the same value twice and expect
    // identical token. (Verifies ScrubMap reuse path is engaged.)
    const overrides: CommitOverrides = {
      Sheet1: { Notes: { pattern: 'custom', label: 'ServerName' } },
    };
    await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
      overrides,
    );
    // After scrub, mint the same raw value again — must return the same token
    // because ScrubMap memoizes.
    const before = map.mint('SERVERNAME', 'reach alpha@invented-domain.test before EOD').token;
    const after = map.mint('SERVERNAME', 'reach alpha@invented-domain.test before EOD').token;
    expect(after).toBe(before);
    expect(before).toMatch(/^\{SERVERNAME(_\d+)?\}$/);
  });

  test('custom-label override with malformed label falls back to regex (defensive)', async () => {
    const buf = await buildDemoWorkbook();
    const map = new ScrubMap();
    // The server route already rejects malformed labels at the boundary —
    // this guards the scrubber's own defensive fallback in case a malformed
    // override slips through programmatic callers.
    const overrides: CommitOverrides = {
      Sheet1: { Notes: { pattern: 'custom', label: '!!' } },
    };
    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
      overrides,
    );
    expect(result.summary.columnsResolved['Sheet1::Notes']).toBe('regex');
  });
});

// ── scrubXlsx — sparse / empty cells ────────────────────────────────────────

describe('scrubXlsx — empty / null cell handling', () => {
  test('null cells don\'t crash and aren\'t counted', async () => {
    const buf = await buildSparseWorkbook();
    const map = new ScrubMap();
    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
    );

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s = wb.getWorksheet('Sheet1');
    expect(s).toBeDefined();
    if (!s) return;

    // Filled cells tokenized
    expect(readCell(s, 2, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);
    expect(readCell(s, 3, 2)).toMatch(/^\{PHONE(_\d+)?\}$/);
    expect(readCell(s, 5, 1)).toMatch(/^\{EMAIL(_\d+)?\}$/);
    expect(readCell(s, 5, 2)).toMatch(/^\{PHONE(_\d+)?\}$/);

    // Empty cells stay empty
    expect(readCell(s, 2, 2)).toBe('');
    expect(readCell(s, 3, 1)).toBe('');
    expect(readCell(s, 4, 1)).toBe('');
    expect(readCell(s, 4, 2)).toBe('');

    // 4 non-empty cells across email + phone columns
    expect(result.summary.cellsScrubbed).toBe(4);
  });
});

// ── Token uniqueness within a single sheet ───────────────────────────────────

describe('scrubXlsx — token uniqueness', () => {
  test('the same email in two cells maps to the same token', async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('Sheet1');
    s.addRow(['Email']);
    s.addRow(['india@invented-domain.test']);
    s.addRow(['india@invented-domain.test']);
    s.addRow(['juliet@invented-domain.test']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const map = new ScrubMap();
    const result = await scrubXlsx(
      buf, map, null,
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
    );

    const out = await loadWorkbook(result.scrubbedBuffer);
    const so = out.getWorksheet('Sheet1');
    expect(so).toBeDefined();
    if (!so) return;
    const r2 = readCell(so, 2, 1);
    const r3 = readCell(so, 3, 1);
    const r4 = readCell(so, 4, 1);
    expect(r2).toBe(r3);   // same email → same token
    expect(r2).not.toBe(r4); // different email → different token
  });
});

// TDD for #63 (SCR-10): exercise 5k-row vocab (large ScrubMap) + 200-cell sheet via scrubXlsx (unresolved -> scrubText path hits apply per cell).
// Correctness: scrubbed cells match expected tokens. Perf under budget. (RED pre-cache.)
describe('SCR-10 xlsx 5k-vocab + 200-cell sheet TDD', () => {
  async function build200CellWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('Data');
    s.addRow(['Notes', 'Misc']);
    for (let i = 0; i < 199; i++) {
      // Mix PII-ish free text (will hit regex fallback + apply) + plain.
      const note = i % 4 === 0
        ? `Call user${i}@example-${(i%30)}.local or 10.0.${i % 200}.${(i%250)} today`
        : `routine note ${i} no pii`;
      s.addRow([note, `val-${i}`]);
    }
    const ab = await wb.xlsx.writeBuffer();
    return Buffer.from(ab as ArrayBuffer);
  }

  test('200-cell xlsx with 5k preloaded map scrubs correctly and under perf budget (via scrubText apply)', async () => {
    const buf = await build200CellWorkbook();
    const map = new ScrubMap();
    const N = 5000;
    // Preload 5k vocab entries (simulates loaded confirmed vocab) — unresolved columns will scrubText and apply this map.
    for (let i = 0; i < N; i++) {
      const real = i % 3 === 0
        ? `user${i}@example-${(i % 30)}.local`
        : `10.0.${i % 200}.${(i % 250)}`;
      map.mint(i % 3 === 0 ? 'HOST' : 'IP', real);
    }

    const start = performance.now();
    const result = await scrubXlsx(
      buf,
      map,
      null, // no vocab store (allowlist not exercised here; covered in vocab.test)
      { xlsx: defaultXlsxCfg, baseConfig: baseCfg },
    );
    const dur = performance.now() - start;

    const wb = await loadWorkbook(result.scrubbedBuffer);
    const s = wb.getWorksheet('Data');
    expect(s).toBeDefined();
    if (!s) return;

    // Correctness: header untouched, data rows for PII columns got tokenized using the preloaded map.
    expect(readCell(s, 1, 1)).toBe('Notes');
    // Check a few known matches were replaced (behavior identical).
    const c2 = readCell(s, 2, 1);
    const c5 = readCell(s, 5, 1);
    if (c2.includes('user')) {
      expect(c2).toMatch(/\{HOST(_\d+)?\}/);
    }
    if (c5.includes('10.0.')) {
      expect(c5).toMatch(/\{IP(_\d+)?\}/);
    }
    // At least some cells scrubbed in fallback path.
    expect(result.summary.cellsScrubbed).toBeGreaterThanOrEqual(40);
    expect(result.summary.rows).toBe(199);

    // Perf guard for #63. This times the FULL scrubXlsx round-trip (ExcelJS
    // binary load + per-cell scrubText + write-back), which is dominated by
    // ExcelJS I/O — measured ~20ms warmed / ~100ms cold locally — NOT by
    // apply(). The original <20ms target mis-modelled the cost as if apply()
    // were the whole path. The apply() trie optimization is asserted DIRECTLY
    // and tightly in scrub-map.test.ts (200 applies vs a 5k map < 5ms) plus a
    // regex-parity proof; this end-to-end budget only needs to catch a gross
    // regression of the old O(vocab) apply that made this path ~45,000ms. 400ms
    // accommodates ExcelJS reality + CI variance while still flagging a >100x
    // blow-up.
    expect(dur).toBeLessThan(400);
    console.log(`[TDD #63] 5k-vocab 200-cell xlsx scrub dur=${dur.toFixed(2)}ms (budget<400)`);
  });
});

// ── SCR-04 / SCR-05 (#57 / #58): rich-text, hyperlink, header, metadata, creds ──
describe('xlsx scrub — non-plain cells, header, metadata, credentials', () => {
  async function loadBack(buf: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb;
  }

  test('SCR-04: rich-text, hyperlink, header PII, sheet name and creator are all tokenized', async () => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Adam Congdon';
    wb.lastModifiedBy = 'Adam Congdon';
    const s = wb.addWorksheet('Acme Corp Sheet');
    // Header row with a PII email as a column title + a normal title.
    s.getCell('A1').value = { richText: [{ text: 'mail ' }, { text: 'header@invented-domain.test' }] };
    s.getCell('B1').value = 'Notes';
    // Rich-text data cell with an email.
    s.getCell('A2').value = { richText: [{ text: 'reach ' }, { text: 'rich@invented-domain.test' }] };
    // Hyperlink cell: display text + mailto target both carry an email.
    s.getCell('B2').value = { text: 'email link@invented-domain.test', hyperlink: 'mailto:link@invented-domain.test' };
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

    const { summary } = await scrubXlsx(buf, new ScrubMap(), null, { xlsx: defaultXlsxCfg, baseConfig: baseCfg });
    const out = await scrubXlsxToBuffer(buf);

    const flat = out;
    expect(flat).not.toContain('header@invented-domain.test');
    expect(flat).not.toContain('rich@invented-domain.test');
    expect(flat).not.toContain('link@invented-domain.test');
    expect(flat).not.toContain('Adam Congdon'); // creator/lastModifiedBy scrubbed
    expect(summary.hasCredentials).toBe(false);
  });

  test('SCR-05: a credential in an Email-force-minted column is redacted, not minted, and flagged', async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('Sheet1');
    s.addRow(['Email']);
    s.addRow(['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

    const map = new ScrubMap();
    const { summary } = await scrubXlsx(buf, map, null, { xlsx: defaultXlsxCfg, baseConfig: baseCfg });
    const out = await scrubXlsxToBuffer(buf, map);

    expect(summary.hasCredentials).toBe(true);
    expect(out).toContain('[CREDENTIAL-REDACTED]');
    expect(out).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12');
    // No vocab row would have been minted for the credential (map has no token for it).
    expect(map.tokenFor('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12')).toBeUndefined();
  });
});

/** Helper: scrub a workbook buffer and return the re-serialized bytes as a UTF-8-ish string for substring assertions. */
async function scrubXlsxToBuffer(buf: Buffer, map?: ScrubMap): Promise<string> {
  const m = map ?? new ScrubMap();
  const { scrubbedBuffer } = await scrubXlsx(buf, m, null, { xlsx: defaultXlsxCfg, baseConfig: baseCfg });
  // xlsx is a zip; load it back and stringify all cell values + metadata so
  // substring assertions are reliable regardless of zip compression.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(scrubbedBuffer as unknown as ArrayBuffer);
  const parts: string[] = [String(wb.creator ?? ''), String(wb.lastModifiedBy ?? ''), String((wb as unknown as Record<string, unknown>).company ?? '')];
  wb.eachSheet((sheet) => {
    parts.push(sheet.name);
    sheet.eachRow((row) => {
      row.eachCell((cell) => { parts.push(cell.text ?? ''); });
    });
  });
  return parts.join('');
}
