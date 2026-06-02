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
export const PROMPT_VERSION = '1';

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
            enum: ['person', 'org', 'address', 'credential', 'hostname', 'other'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', maxLength: 280 },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You are a privacy auditor. Read the text below — it has already been scrubbed by a',
  'regex and vocabulary layer. Your only job is to find personally identifiable',
  'information (PII) the upstream layer missed. Be conservative: only flag spans you',
  'are confident about. You cannot mutate the text. Findings go to a human review queue.',
  '',
  'Look specifically for things regex tends to miss:',
  '  - person names in non-Latin scripts (Korean, Arabic, Hebrew, Vietnamese, Thai, etc.)',
  '  - regional address formats (Indian PIN codes, UK postcodes, JP prefectures, etc.)',
  '  - novel credential patterns (vendor-specific API tokens, signed-URL secrets)',
  '  - rare or non-English organisation names',
  '  - hostnames that look like internal infrastructure',
  '',
  'Categories you may use (use exactly these strings):',
  '  "person"     — a human name',
  '  "org"        — a company, customer, vendor, or institution name',
  '  "address"    — a postal address fragment (street, city+postcode, region code)',
  '  "credential" — a token, secret, key, or password',
  '  "hostname"   — an FQDN or internal hostname',
  '  "other"      — PII that fits none of the above',
  '',
  'Do NOT flag spans that match the pattern ^\\{[A-Z][A-Z0-9_]*\\}$ — those are tokens',
  'already minted by the upstream scrubber (for example {PERSON}, {EMAIL_2}, {IP_10}).',
  '',
  'Respond with JSON conforming exactly to the provided schema. No prose, no markdown,',
  'no code fences. Each span must include the verbatim text from the input, a category,',
  'a confidence in [0,1], and a one-sentence reason.',
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
