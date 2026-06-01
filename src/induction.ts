/**
 * Pattern induction — derives a regex from a set of string examples.
 *
 * Fully deterministic, zero network calls, zero LLM calls.
 * Algorithm: tokenize → align shapes → emit regex or fall back to prefix+suffix.
 */

export interface InductionOpts {
  minExamples?: number;
  minSpecificity?: number;
  maxNegativeHitRatio?: number;
  maxPatternLength?: number;
}

export interface InducedPattern {
  source: RegExp;
  examples: string[];
  skeleton: string;
  coverage: number;
  specificity: number;
}

type TokenKind = 'U' | 'L' | 'D' | 'LIT';

interface ShapeToken {
  kind: TokenKind;
  count?: number;   // for U/L/D
  literal?: string; // for LIT (single char)
}

// Characters that must be escaped inside a regex literal
const META_CHARS = new Set(['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\', '/']);

function escapeLiteral(c: string): string {
  if (META_CHARS.has(c)) return `\\${c}`;
  return c;
}

function tokenize(s: string): ShapeToken[] {
  const tokens: ShapeToken[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/[A-Z]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[A-Z]/.test(s[j])) j++;
      tokens.push({ kind: 'U', count: j - i });
      i = j;
    } else if (/[a-z]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[a-z]/.test(s[j])) j++;
      tokens.push({ kind: 'L', count: j - i });
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      tokens.push({ kind: 'D', count: j - i });
      i = j;
    } else {
      tokens.push({ kind: 'LIT', literal: ch });
      i++;
    }
  }
  return tokens;
}

function tokenSequenceKey(tokens: ShapeToken[]): string {
  return tokens.map((t) => t.kind).join(',');
}

interface AlignedBuildResult {
  body: string;
  literalCharCount: number;
}

function buildRegexFromAlignedTokens(
  tokenMatrix: ShapeToken[][],
  origExamples: string[],
): AlignedBuildResult {
  const numTokens = tokenMatrix[0].length;
  const parts: string[] = [];
  let literalCharCount = 0;

  for (let ti = 0; ti < numTokens; ti++) {
    const col = tokenMatrix.map((row) => row[ti]);
    const kind = col[0].kind;

    if (kind === 'LIT') {
      const lit = col[0].literal ?? '';
      parts.push(escapeLiteral(lit));
      literalCharCount++;
    } else {
      // Check if all examples have the same exact substring for this token position.
      // If so, emit it as a literal for higher specificity.
      const vals = getColumnValues(tokenMatrix, origExamples, ti);
      const allSame = vals.length > 0 && vals.every((v) => v === vals[0]);

      if (allSame && vals[0]) {
        // Emit the literal value (all examples share exact same chars here)
        const escapedLit = vals[0].split('').map(escapeLiteral).join('');
        parts.push(escapedLit);
        literalCharCount += vals[0].length;
      } else {
        const counts = col.map((t) => t.count ?? 1);
        const minC = Math.min(...counts);
        const maxC = Math.max(...counts);
        const quantifier = minC === maxC ? `{${minC}}` : `{${minC},${maxC}}`;

        if (kind === 'U') parts.push(`[A-Z]${quantifier}`);
        else if (kind === 'L') parts.push(`[a-z]${quantifier}`);
        else parts.push(`\\d${quantifier}`);
      }
    }
  }

  return { body: parts.join(''), literalCharCount };
}

/**
 * Extract the actual substring each example contributes at token position `ti`.
 * Walks the tokenized form of each (sorted) example and extracts the raw chars.
 */
function getColumnValues(
  tokenMatrix: ShapeToken[][],
  origExamples: string[],
  targetTi: number,
): string[] {
  const result: string[] = [];
  for (let ei = 0; ei < tokenMatrix.length; ei++) {
    const row = tokenMatrix[ei];
    const ex = origExamples[ei];
    let charPos = 0;
    for (let ti = 0; ti < row.length; ti++) {
      const tok = row[ti];
      if (ti === targetTi) {
        const len = tok.kind === 'LIT' ? 1 : (tok.count ?? 1);
        result.push(ex.slice(charPos, charPos + len));
        break;
      }
      charPos += tok.kind === 'LIT' ? 1 : (tok.count ?? 1);
    }
  }
  return result;
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

function longestCommonSuffix(strings: string[]): string {
  const reversed = strings.map((s) => s.split('').reverse().join(''));
  const revSuffix = longestCommonPrefix(reversed);
  return revSuffix.split('').reverse().join('');
}

/**
 * Decides whether a regex body starts/ends with a word-character pattern.
 * Used to determine if \\b anchors are appropriate.
 */
function startsWithWordChar(regexBody: string): boolean {
  // Starts with [A-Z], [a-z], \d, or \w
  return /^(\[A-Z\]|\[a-z\]|\\d|\\w|[A-Za-z0-9_])/.test(regexBody);
}

function endsWithWordChar(regexBody: string): boolean {
  // Ends with a quantifier on a word-class pattern, or a literal word char
  return /(\}|[A-Za-z0-9_])$/.test(regexBody);
}

/**
 * Compute specificity = literal chars (from LIT tokens + uniform non-LIT tokens)
 * divided by average example length.
 * INC-12345 → INC(3 uniform) + -(1 LIT) = 4 literal chars / 9 avgLen = 0.44.
 * a,b,c → 0 / 1 = 0. 12345,99001 → 0 / 5 = 0.
 */
function computeSpecificityFromAligned(
  literalCharCount: number,
  examples: string[],
): number {
  if (examples.length === 0) return 0;
  const avgLen = examples.reduce((s, e) => s + e.length, 0) / examples.length;
  if (avgLen === 0) return 0;
  return literalCharCount / avgLen;
}

/**
 * Compute specificity from prefix+suffix literal length vs average example length.
 */
function computeSpecificityFromPrefixSuffix(
  prefix: string,
  suffix: string,
  examples: string[],
): number {
  if (examples.length === 0) return 0;
  const literalLen = prefix.length + suffix.length;
  const avgLen = examples.reduce((s, e) => s + e.length, 0) / examples.length;
  if (avgLen === 0) return 0;
  return literalLen / avgLen;
}

export function induceRegex(
  examples: string[],
  opts?: InductionOpts,
): InducedPattern | null {
  const minExamples = opts?.minExamples ?? 3;
  const minSpecificity = opts?.minSpecificity ?? 0.3;
  const maxPatternLength = opts?.maxPatternLength ?? 200;

  if (examples.length < minExamples) return null;

  // Sort for determinism
  const sorted = [...examples].sort();

  // ── Step 1: Tokenize all examples ──────────────────────────────────────────
  const tokenized = sorted.map(tokenize);

  // ── Step 2: Check alignment — same token-kind sequence across all examples ─
  const firstKey = tokenSequenceKey(tokenized[0]);
  const allAligned = tokenized.every((t) => tokenSequenceKey(t) === firstKey);

  let regexBody = '';
  let skeleton = '';
  let specificity = 0;

  if (allAligned) {
    // All token shapes match — build directly from aligned token matrix
    const built = buildRegexFromAlignedTokens(tokenized, sorted);
    regexBody = built.body;
    skeleton = regexBody;
    specificity = computeSpecificityFromAligned(built.literalCharCount, sorted);
  }

  // ── Fallback path — used when not aligned, OR when aligned specificity is
  // too low (e.g. only a separator LIT provides the anchor). ─────────────────
  if (!allAligned || specificity < minSpecificity) {
    const prefix = longestCommonPrefix(sorted);
    const suffix = longestCommonSuffix(sorted);

    // Need at least 2 combined literal characters for a meaningful anchor
    const combinedLiteralLen = prefix.length + suffix.length;
    if (combinedLiteralLen < 2) return null;

    // Avoid double-counting when prefix + suffix overlap (short examples)
    const minMiddleLen = Math.max(
      0,
      Math.min(...sorted.map((s) => s.length - prefix.length - suffix.length)),
    );
    const maxMiddleLen = Math.max(
      ...sorted.map((s) => s.length - prefix.length - suffix.length),
    );

    if (minMiddleLen < 0) return null;

    const escapedPrefix = prefix.split('').map(escapeLiteral).join('');
    const escapedSuffix = suffix.split('').map(escapeLiteral).join('');
    const middlePart = minMiddleLen === maxMiddleLen
      ? `.{${minMiddleLen}}`
      : `.{${minMiddleLen},${maxMiddleLen}}`;

    regexBody = `${escapedPrefix}${middlePart}${escapedSuffix}`;
    skeleton = regexBody;
    specificity = computeSpecificityFromPrefixSuffix(prefix, suffix, sorted);
  }

  // ── Step 4: Specificity check ───────────────────────────────────────────────
  if (specificity < minSpecificity) return null;

  // ── Step 5: Apply word-boundary anchors ─────────────────────────────────────
  const addLeadingBoundary = startsWithWordChar(regexBody);
  const addTrailingBoundary = endsWithWordChar(regexBody);

  let finalBody = regexBody;
  if (addLeadingBoundary) finalBody = `\\b${finalBody}`;
  if (addTrailingBoundary) finalBody = `${finalBody}\\b`;

  // ── Step 6: Length check ────────────────────────────────────────────────────
  if (finalBody.length > maxPatternLength) return null;

  // ── Step 7: Coverage check — must match all source examples ─────────────────
  let rx: RegExp;
  try {
    rx = new RegExp(finalBody);
  } catch {
    return null;
  }

  const matchedCount = examples.filter((ex) => rx.test(ex)).length;
  const coverage = matchedCount / examples.length;
  if (coverage < 1.0) return null;

  return {
    source: rx,
    examples,
    skeleton,
    coverage,
    specificity,
  };
}
