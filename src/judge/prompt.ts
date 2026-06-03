/**
 * Judge prompt — pinned system + user prompt for the local LLM secondary validator.
 *
 * The judge sees the *already-scrubbed* text and is asked to flag residual PII the
 * regex+vocab layer might have missed (multilingual person names, regional address
 * formats, novel credential patterns, rare org names). It can only ADD review
 * items — it never mutates scrub output.
 *
 * See `Plans/LLM_RESEARCH.md` and `Plans/no-let-s-use-development-glittery-ladybug.md`
 * (Phase 3) for design rationale. PROMPT_VERSION lets us A/B prompt iterations later.
 */

/** Pinned prompt version. Bump on any user-prompt or system-prompt change. */
export const PROMPT_VERSION = '3';

/**
 * JSON Schema for the model's response. llama.cpp's `response_format` with
 * `type: 'json_schema'` enforces this structurally at decode time.
 */
export const JUDGE_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['suspicious_spans'],
  properties: {
    suspicious_spans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'category', 'confidence', 'reason'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 200 },
          category: {
            type: 'string',
            enum: ['person', 'org', 'address', 'credential', 'hostname', 'url', 'other'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', maxLength: 280 },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You are a privacy auditor. The text below has been partially scrubbed by a regex layer.',
  'Your job is to find ANY remaining personally identifiable information (PII) the regex',
  'missed. Prefer over-flagging to under-flagging — a human will review your findings.',
  'You cannot mutate the text. Do not explain yourself outside the JSON response.',
  '',
  'Flag ALL of these when found in the text:',
  '  - Person names (first, last, or full) — including common English/Western names like',
  '    "John", "Sarah", "Mike Smith", "Jennifer Adams", etc.',
  '  - Person names in non-Latin scripts (Korean, Arabic, Hebrew, Vietnamese, Thai, etc.)',
  '  - Company, vendor, or customer organisation names',
  '  - Email addresses (even partially visible)',
  '  - Website URLs (https://..., http://..., www....)',
  '  - Internal hostnames and FQDNs',
  '  - Postal addresses, cities, postcodes, regional identifiers',
  '  - API tokens, secrets, keys, passwords, or credential strings',
  '  - Phone numbers or account numbers',
  '',
  'Categories you must use (use exactly these strings):',
  '  "person"     — any human name',
  '  "org"        — a company, customer, vendor, or institution name',
  '  "address"    — a postal address, city, postcode, or region',
  '  "credential" — a token, secret, key, or password',
  '  "hostname"   — an FQDN or internal hostname',
  '  "url"        — a full website URL (http/https/www)',
  '  "other"      — PII that fits none of the above (phone, account number, etc.)',
  '',
  'The text contains "[*]" markers where PII has already been removed by an upstream layer.',
  'Treat each "[*]" as opaque — do not flag it, do not return it as a span.',
  'Focus only on the plain text surrounding the markers, where real names, URLs,',
  'hostnames, and other PII may still appear unredacted.',
  '',
  'Respond with JSON matching the schema exactly. No prose, no markdown, no code fences.',
  'Each entry needs: verbatim text from input, category, confidence 0–1, one-sentence reason.',
].join('\n');

/**
 * Build the system+user prompt pair for a single judge call.
 * `maxSpans` is communicated to the model as a soft cap; the post-processor
 * enforces it as a hard cap.
 */
export function buildJudgePrompt(
  scrubbed: string,
  maxSpans: number,
): { system: string; user: string } {
  const user = [
    `Return AT MOST ${maxSpans} suspicious spans. If you find none, return an empty array.`,
    '',
    '--- BEGIN SCRUBBED TEXT ---',
    scrubbed,
    '--- END SCRUBBED TEXT ---',
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}
