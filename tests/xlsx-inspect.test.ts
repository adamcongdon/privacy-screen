/**
 * xlsx-inspect tests — Issue #23 data layer.
 *
 * Verifies `inspectXlsx` returns expected per-column resolution, the
 * sample value is the first non-empty cell (truncated), row counts
 * exclude the header, and no mutation occurs (input bytes preserved).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import ExcelJS from 'exceljs';
import { inspectXlsx, type XlsxConfig } from '../src/xlsx-scrubber';

// ── Fixture builder ──────────────────────────────────────────────────────────

async function build2SheetWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const s1 = wb.addWorksheet('Sheet1');
  s1.addRow(['Email', 'Phone', 'Notes', 'ID']);
  s1.addRow(['kilo@invented-domain.test', '(555) 010-3001', 'first note', 2001]);
  s1.addRow(['lima@invented-domain.test', '(555) 010-3002', 'second note', 2002]);

  const s2 = wb.addWorksheet('Sheet2');
  s2.addRow(['Customer Mail', 'Misc']);
  s2.addRow(['mike@invented-domain.test', 'm-1']);
  s2.addRow(['november@invented-domain.test', 'm-2']);

  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

async function buildLongSampleWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('S');
  s.addRow(['Notes']);
  // 120-char string to exercise the 80-char truncation.
  s.addRow(['a'.repeat(120)]);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

async function buildBlankColumnsWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('S');
  s.addRow(['Email', 'Phone']);
  s.addRow([null, '(555) 010-3050']); // Email col first row empty
  s.addRow(['oscar@invented-domain.test', null]);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('inspectXlsx — auto-detect', () => {
  let buf: Buffer;
  beforeAll(async () => { buf = await build2SheetWorkbook(); });

  test('returns one entry per sheet, in workbook order', async () => {
    const result = await inspectXlsx(buf);
    expect(result.sheets.length).toBe(2);
    expect(result.sheets[0].name).toBe('Sheet1');
    expect(result.sheets[1].name).toBe('Sheet2');
  });

  test('Sheet1 columns resolve via heuristic', async () => {
    const result = await inspectXlsx(buf);
    const cols = result.sheets[0].columns;
    expect(cols.length).toBe(4);

    const [email, phone, notes, id] = cols;
    expect(email.header).toBe('Email');
    expect(email.resolvedPattern).toBe('Email');
    expect(email.source).toBe('heuristic');
    expect(email.sampleValue).toBe('kilo@invented-domain.test');

    expect(phone.header).toBe('Phone');
    expect(phone.resolvedPattern).toBe('Phone');
    expect(phone.source).toBe('heuristic');
    expect(phone.sampleValue).toBe('(555) 010-3001');

    expect(notes.header).toBe('Notes');
    expect(notes.resolvedPattern).toBeNull();
    expect(notes.source).toBe('unresolved');
    expect(notes.sampleValue).toBe('first note');

    expect(id.header).toBe('ID');
    expect(id.resolvedPattern).toBeNull();
    expect(id.source).toBe('unresolved');
    // exceljs stringifies numeric cell values for `cell.text`
    expect(id.sampleValue).toBe('2001');
  });

  test('row count excludes header', async () => {
    const result = await inspectXlsx(buf);
    expect(result.sheets[0].rowCount).toBe(2);
    expect(result.sheets[1].rowCount).toBe(2);
  });
});

describe('inspectXlsx — explicit rule', () => {
  test('"Customer Mail" header resolves via columnRules', async () => {
    const buf = await build2SheetWorkbook();
    const cfg: XlsxConfig = {
      autoDetect: true,
      columnRules: [{ header: 'Customer Mail', pattern: 'Email' }],
    };
    const result = await inspectXlsx(buf, cfg);
    const s2 = result.sheets[1];
    const cm = s2.columns.find((c) => c.header === 'Customer Mail');
    expect(cm).toBeDefined();
    expect(cm?.resolvedPattern).toBe('Email');
    expect(cm?.source).toBe('rule');
  });

  test('with autoDetect: false, heuristic does NOT fire', async () => {
    const buf = await build2SheetWorkbook();
    const cfg: XlsxConfig = { autoDetect: false, columnRules: [] };
    const result = await inspectXlsx(buf, cfg);
    const s1 = result.sheets[0];
    const email = s1.columns.find((c) => c.header === 'Email');
    expect(email).toBeDefined();
    expect(email?.resolvedPattern).toBeNull();
    expect(email?.source).toBe('unresolved');
  });
});

describe('inspectXlsx — sample value', () => {
  test('truncates sample values longer than 80 chars', async () => {
    const buf = await buildLongSampleWorkbook();
    const result = await inspectXlsx(buf);
    const sample = result.sheets[0].columns[0].sampleValue;
    expect(sample).not.toBeNull();
    expect(sample!.length).toBe(80);
    expect(sample!.endsWith('…')).toBe(true);
  });

  test('walks past empty cells to find first non-empty value', async () => {
    const buf = await buildBlankColumnsWorkbook();
    const result = await inspectXlsx(buf);
    const cols = result.sheets[0].columns;
    const email = cols.find((c) => c.header === 'Email');
    const phone = cols.find((c) => c.header === 'Phone');
    expect(email?.sampleValue).toBe('oscar@invented-domain.test');
    expect(phone?.sampleValue).toBe('(555) 010-3050');
  });
});

describe('inspectXlsx — no mutation', () => {
  test('input buffer bytes unchanged after inspect', async () => {
    const buf = await build2SheetWorkbook();
    const before = Buffer.from(buf); // copy for comparison
    await inspectXlsx(buf);
    expect(buf.equals(before)).toBe(true);
  });
});
