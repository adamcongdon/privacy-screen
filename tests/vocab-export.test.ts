/**
 * #89 (WEB-07) — Vocabulary export must be safe-by-default.
 *
 * Acceptance:
 * - Default/safe export has no `real_value` field (tokens + categories only).
 * - Full export includes `real_value` only when explicitly requested.
 * - Full export filename is visibly flagged SENSITIVE.
 * - UI gates full export behind acknowledgement (source contract — no Radix mount).
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildExportPayload,
  exportFilename,
  FULL_EXPORT_WARNING,
  type VocabExportRow,
} from '../web/src/components/flow/VocabularyPage';

const sampleRows: VocabExportRow[] = [
  { token: '{EMAIL_1}', realValue: 'alice@example.com', category: 'email', uses: 3 },
  { token: '{PERSON_1}', realValue: 'Alice Example', category: 'person', uses: null },
];

test('vocab export #89: safe payload omits real_value (default)', () => {
  const payload = buildExportPayload(sampleRows, false);
  expect(payload).toHaveLength(2);
  for (const row of payload) {
    expect(row).toEqual(
      expect.objectContaining({
        token: expect.any(String),
        category: expect.any(String),
      }),
    );
    expect('real_value' in row).toBe(false);
    expect(Object.keys(row).sort()).toEqual(['category', 'token', 'uses'].sort());
  }
  expect(payload[0]).toEqual({
    token: '{EMAIL_1}',
    category: 'email',
    uses: 3,
  });
});

test('vocab export #89: full payload includes real_value only when asked', () => {
  const payload = buildExportPayload(sampleRows, true);
  expect(payload).toHaveLength(2);
  expect(payload[0]).toEqual({
    token: '{EMAIL_1}',
    category: 'email',
    uses: 3,
    real_value: 'alice@example.com',
  });
  expect(payload[1]).toEqual({
    token: '{PERSON_1}',
    category: 'person',
    uses: null,
    real_value: 'Alice Example',
  });
  for (const row of payload) {
    expect('real_value' in row).toBe(true);
  }
});

test('vocab export #89: safe filename is plain; full is SENSITIVE-dated', () => {
  expect(exportFilename(false)).toBe('privacy-screen-vocabulary.json');
  const fixed = new Date(Date.UTC(2026, 6, 13)); // 2026-07-13
  expect(exportFilename(true, fixed)).toBe(
    'privacy-screen-vocabulary-SENSITIVE-20260713.json',
  );
  expect(exportFilename(true, fixed)).toContain('SENSITIVE');
});

test('vocab export #89: FULL_EXPORT_WARNING names deanonymization risk', () => {
  expect(FULL_EXPORT_WARNING.toLowerCase()).toContain('real values');
  expect(FULL_EXPORT_WARNING.toLowerCase()).toMatch(/deanonymiz|key to deanonymize/);
  expect(FULL_EXPORT_WARNING.toLowerCase()).toMatch(/synced|backed-up|backup/);
});

test('vocab export #89: source gates full export behind ack checkbox', () => {
  const source = readFileSync(
    join(import.meta.dir, '../web/src/components/flow/VocabularyPage.tsx'),
    'utf-8',
  );
  // Dialog exists and does not silently download real_value on Export click.
  expect(source).toContain('VocabExportDialog');
  expect(source).toContain('export-full-ack');
  expect(source).toContain('export-safe-btn');
  expect(source).toContain('export-full-btn');
  expect(source).toContain('disabled={!ackFull}');
  // Safe path is the primary finishExport(false); full is finishExport(true).
  expect(source).toContain('onExportSafe={() => finishExport(false)}');
  expect(source).toContain('onExportFull={() => finishExport(true)}');
  // Must not still have the old silent map that always included real_value.
  expect(source).not.toMatch(
    /const payload = rows\.map\(\(r\) => \(\{[\s\S]*real_value: r\.realValue/,
  );
});
