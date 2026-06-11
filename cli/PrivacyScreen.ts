#!/usr/bin/env bun
/**
 * PrivacyScreen CLI — vocabulary and review-queue management
 *
 * Usage:
 *   bun PAI/TOOLS/PrivacyScreen.ts review              — triage pending review items
 *   bun PAI/TOOLS/PrivacyScreen.ts vocab list           — list all vocab
 *   bun PAI/TOOLS/PrivacyScreen.ts vocab list -c CUSTOMER
 *   bun PAI/TOOLS/PrivacyScreen.ts vocab forget <real>  — remove vocab entry
 *   bun PAI/TOOLS/PrivacyScreen.ts allowlist add <pat>  — never tokenize pattern
 *   bun PAI/TOOLS/PrivacyScreen.ts allowlist add <pat> --regex
 *   bun PAI/TOOLS/PrivacyScreen.ts scrub                — pipe-in scrubber test
 *   bun PAI/TOOLS/PrivacyScreen.ts stats                — daily redaction stats
 */

import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, createWriteStream, renameSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { VocabStore, defaultDbPath } from '../src/vocab';
import { ScrubMap } from '../src/scrub-map';
import { scrubText } from '../src/scrubber';
import { induceRegex } from '../src/induction';
import { runInstallJudge } from './install-judge';

const DB = defaultDbPath();

function store(): VocabStore {
  return new VocabStore(DB);
}

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'review':
    await cmdReview();
    break;
  case 'vocab':
    await cmdVocab(rest);
    break;
  case 'allowlist':
    await cmdAllowlist(rest);
    break;
  case 'scrub':
    await cmdScrub();
    break;
  case 'stats':
    await cmdStats(rest);
    break;
  case 'induct':
    await cmdInduct(rest);
    break;
  case 'patterns':
    await cmdPatterns(rest);
    break;
  case 'install-judge':
    await cmdInstallJudge(rest);
    break;
  default:
    printHelp();
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdReview(): Promise<void> {
  const s = store();
  const items = s.pendingReview();
  if (items.length === 0) {
    console.log('✅ No pending review items.');
    s.close();
    return;
  }

  console.log(`\n🔍 ${items.length} item(s) pending review\n`);

  for (const item of items) {
    console.log(`─────────────────────────────────────────`);
    console.log(`  Span:        "${item.span}"`);
    console.log(`  Context:     "${item.surrounding}"`);
    console.log(`  Category:    ${item.suggested_cat ?? 'unknown'}`);
    console.log(`  Confidence:  ${(item.confidence * 100).toFixed(0)}%`);
    console.log(`  Source:      ${item.source_event}`);
    console.log(``);
    console.log(`  [c] Confirm as PII (add to vocab)`);
    console.log(`  [a] Allowlist (never flag again)`);
    console.log(`  [i] Ignore (one-time pass, stays in queue)`);
    console.log(`  [s] Skip for now`);
    console.log(`  [q] Quit`);

    const answer = await prompt('  Choice: ');

    switch (answer?.toLowerCase().trim()) {
      case 'c': {
        const typeInput = await prompt(`  Token type (default: ${item.suggested_cat?.toUpperCase() ?? 'CUST'}): `);
        const type = (typeInput?.trim() || item.suggested_cat?.toUpperCase() || 'CUST').toUpperCase();
        const map = new ScrubMap();
        s.loadIntoMap(map);
        const { token } = map.mint(type, item.span);
        s.persistMint(item.span, token, item.suggested_cat ?? type.toLowerCase(), 1.0);
        s.setReviewStatus(item.id, 'confirmed');
        console.log(`  ✅ Added: "${item.span}" → ${token}`);
        break;
      }
      case 'a':
        s.addAllowlist(item.span, false, 'user-confirmed safe');
        s.setReviewStatus(item.id, 'allowlisted');
        console.log(`  ✅ Allowlisted: "${item.span}"`);
        break;
      case 'i':
        s.setReviewStatus(item.id, 'ignored');
        console.log(`  ⏭️  Ignored.`);
        break;
      case 'q':
        s.close();
        process.exit(0);
        break;
      default:
        console.log(`  ⏭️  Skipped.`);
    }
    console.log('');
  }

  s.close();
  console.log('Done.');
}

async function cmdVocab(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'list') {
    const cIdx = args.indexOf('-c');
    const catIdx = args.indexOf('--category');
    const cat = (cIdx !== -1 ? args[cIdx + 1] : undefined) || (catIdx !== -1 ? args[catIdx + 1] : undefined);
    const s = store();
    const rows = s.allVocab(cat);
    s.close();
    if (rows.length === 0) {
      console.log('No vocab entries.');
      return;
    }
    const colW = [30, 14, 12, 8, 12];
    const header = padRow(['Real Value', 'Token', 'Category', 'Hits', 'Confirmed'], colW);
    console.log('\n' + header);
    console.log('─'.repeat(header.length));
    for (const r of rows) {
      console.log(padRow([
        truncate(r.real_value, 28),
        r.token,
        r.category,
        String(r.hit_count),
        r.confirmed_by ?? '(pending)',
      ], colW));
    }
    console.log(`\n${rows.length} entries`);
  } else if (sub === 'forget') {
    const val = args[1];
    if (!val) { console.error('Usage: vocab forget <real_value>'); process.exit(1); }
    const s = store();
    const ok = s.forgetReal(val);
    s.close();
    console.log(ok ? `✅ Removed "${val}"` : `⚠️  Not found: "${val}"`);
  } else {
    console.log('Usage: vocab list [-c CATEGORY] | vocab forget <value>');
  }
}

async function cmdAllowlist(args: string[]): Promise<void> {
  if (args[0] !== 'add' || !args[1]) {
    console.log('Usage: allowlist add <pattern> [--regex]');
    return;
  }
  const pattern = args[1];
  const isRegex = args.includes('--regex');
  const s = store();
  s.addAllowlist(pattern, isRegex);
  s.close();
  console.log(`✅ Allowlisted: "${pattern}" (${isRegex ? 'regex' : 'literal'})`);
}

async function cmdScrub(): Promise<void> {
  // Bun.stdin.text() is reliable across macOS + Linux pipes (and when spawned
  // with custom stdin). The previous readFileSync('/dev/stdin') was the exact
  // Linux-pipe (and some spawn) bug the hook already fixed at
  // hooks/PrivacyScreen.hook.ts:62; it could yield '' (or EACCES) leading to
  // silent "clean" output for 'cli scrub'. Now explicit error on no input.
  const text = await Bun.stdin.text();
  if (!text.trim()) {
    console.error('No input received — pipe text into this command, e.g.:');
    console.error('  echo "my text" | bun cli/PrivacyScreen.ts scrub');
    process.exit(1);
  }
  const s = store();
  const map = new ScrubMap();
  s.loadIntoMap(map);
  const result = scrubText(text, map, s, { sourceEvent: 'cli:scrub' });
  s.close();
  console.log('\n── Scrubbed output ──────────────────────────────');
  console.log(result.scrubbed);
  if (result.mintedTokens.length > 0) {
    console.log('\n── Token map ────────────────────────────────────');
    for (const { token, realValue, isNew } of result.mintedTokens) {
      console.log(`  ${token.padEnd(14)} → "${realValue}"${isNew ? ' (new)' : ''}`);
    }
  }
  if (result.unsureSpans.length > 0) {
    console.log('\n── Review queue (heuristic — not auto-tokenized) ─');
    for (const { span, suggestedCategory, confidence } of result.unsureSpans) {
      console.log(
        `  "${span}"  [${suggestedCategory ?? '?'} @ ${(confidence * 100).toFixed(0)}%] — confirm via \`cli review\``,
      );
    }
    console.log('  In enforce mode this would BLOCK the prompt.');
  }
  if (result.hasCredentials) {
    console.log('\n⚠️  CREDENTIAL DETECTED — would block in hook.');
    if (result.credentialSnippets.length > 0) {
      console.log(`  Detected: ${result.credentialSnippets.join(', ')}`);
    }
  }
}

async function cmdStats(args: string[]): Promise<void> {
  const days = parseInt(args[0] ?? '7', 10);
  const s = store();
  const rows = s.stats(days);
  const pending = s.pendingReview().length;
  const total = s.allVocab().length;
  s.close();

  console.log(`\n── PrivacyScreen Stats (last ${days}d) ───────────────`);
  if (rows.length === 0) {
    console.log('  No activity.');
  } else {
    for (const r of rows) {
      console.log(`  ${r.day}  minted=${r.minted}  reused=${r.reused}  blocked=${r.blocked}`);
    }
  }
  console.log(`\n  Vocab: ${total} entries   Review queue: ${pending} pending`);
}

async function cmdInduct(args: string[]): Promise<void> {
  const catIdx = args.indexOf('--category');
  const targetCat = catIdx !== -1 ? args[catIdx + 1] : undefined;
  const auto = args.includes('--auto');
  const minIdx = args.indexOf('--min');
  const minExamples = minIdx !== -1 ? parseInt(args[minIdx + 1] ?? '3', 10) : 3;

  const s = store();
  const categories = targetCat
    ? [{ category: targetCat, count: s.vocabByCategory(targetCat).length }]
    : s.categoriesAboveThreshold(minExamples);

  if (categories.length === 0) {
    console.log(`No categories with ≥${minExamples} examples. Mint more values first.`);
    s.close();
    return;
  }

  console.log(`\n🔍 Analyzing ${categories.length} category/categories...\n`);

  for (const { category, count } of categories) {
    const examples = s.vocabByCategory(category).map((r) => r.real_value);
    console.log(`─── ${category.toUpperCase()} (${count} examples) ─────────────────`);

    const result = induceRegex(examples, { minExamples });
    if (!result) {
      console.log(`  ⚠️  Could not induce a safe regex for this category.\n`);
      continue;
    }

    console.log(`  Skeleton:    ${result.skeleton}`);
    console.log(`  Regex:       ${result.source}`);
    console.log(`  Coverage:    ${(result.coverage * 100).toFixed(0)}%`);
    console.log(`  Specificity: ${(result.specificity * 100).toFixed(0)}%`);
    console.log(`  Examples:    ${examples.slice(0, 5).join(', ')}${examples.length > 5 ? '…' : ''}`);
    console.log('');

    let accept = auto;
    if (!auto) {
      const answer = await prompt('  [a] Activate  [e] Edit  [r] Reject  [s] Skip: ');
      const choice = answer?.toLowerCase().trim();
      if (choice === 'a') accept = true;
      else if (choice === 'e') {
        const edited = await prompt(`  Edit regex (current: ${result.skeleton}): `);
        if (edited?.trim()) {
          const id = s.persistInducedPattern({
            category,
            regex_source: edited.trim(),
            skeleton: edited.trim(),
            source_examples: examples,
            confidence: result.specificity,
          });
          console.log(`  ✅ Activated (edited) as ID ${id}\n`);
          continue;
        }
      } else if (choice === 'r') {
        console.log(`  ⏭️  Rejected.\n`);
        continue;
      } else {
        console.log(`  ⏭️  Skipped.\n`);
        continue;
      }
    }

    if (accept) {
      const id = s.persistInducedPattern({
        category,
        regex_source: result.source.source,
        skeleton: result.skeleton,
        source_examples: examples,
        confidence: result.specificity,
      });
      console.log(`  ✅ Activated as ID ${id}\n`);
    }
  }

  s.close();
  console.log('Done.');
}

async function cmdPatterns(args: string[]): Promise<void> {
  const sub = args[0];
  const s = store();

  if (sub === 'list') {
    const rows = [...s.activePatterns(), ...s.pendingPatterns()];
    s.close();
    if (rows.length === 0) { console.log('No induced patterns.'); return; }
    for (const r of rows) {
      const exs = (typeof r.source_examples === 'string' ? JSON.parse(r.source_examples) : r.source_examples) as string[];
      console.log(`  [${r.id}] ${r.status.padEnd(8)} ${r.skeleton.padEnd(30)} cat=${r.category} hits=${r.hit_count}`);
      console.log(`         Examples: ${exs.slice(0, 3).join(', ')}`);
    }
  } else if (sub === 'activate' && args[1]) {
    s.setInducedStatus(parseInt(args[1], 10), 'active');
    s.close();
    console.log(`✅ Pattern ${args[1]} activated.`);
  } else if (sub === 'reject' && args[1]) {
    s.setInducedStatus(parseInt(args[1], 10), 'rejected');
    s.close();
    console.log(`✅ Pattern ${args[1]} rejected.`);
  } else if (sub === 'delete' && args[1]) {
    s.deleteInducedPattern(parseInt(args[1], 10));
    s.close();
    console.log(`✅ Pattern ${args[1]} deleted.`);
  } else {
    s.close();
    console.log('Usage: patterns list|activate <id>|reject <id>|delete <id>');
  }
}

async function cmdInstallJudge(args: string[]): Promise<void> {
  const result = await runInstallJudge(args, {
    fetchImpl: fetch,
    homedir,
    fsExists: existsSync,
    fsMkdir: (p) => mkdirSync(p, { recursive: true }),
    fsWrite: (p, data) => writeFileSync(p, data),
    fsCreateWriteStream: (p) => createWriteStream(p),
    fsRename: renameSync,
    fsUnlink: unlinkSync,
    whichLlamaServer: () => {
      try {
        return execSync('which llama-server', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim() || null;
      } catch {
        return null;
      }
    },
    platform: () => process.platform,
  });
  if (result.message) process.stdout.write(result.message);
  if (result.stderrMessage) process.stderr.write(result.stderrMessage);
  if (!result.ok) process.exit(1);
}

function printHelp(): void {
  console.log(`
PrivacyScreen CLI — PII vocabulary & review queue management

Commands:
  review                          Interactive triage of pending review items
  vocab list [-c CAT]             List vocabulary entries (optionally filter by category)
  vocab forget <val>              Remove a vocabulary entry
  allowlist add <pat>             Never tokenize this pattern (--regex for regex match)
  scrub                           Read stdin, scrub, print result + token map
  stats [days=7]                  Show daily redaction activity
  induct [--category CAT]         Induce regex patterns from minted vocab
         [--auto] [--min N]       --auto skips prompts, --min sets example threshold (default 3)
  patterns list                   List all induced patterns
  patterns activate|reject|delete <id>  Manage a specific induced pattern
  install-judge --runtime         Locate llama-server or print install hints
  install-judge --model <name> --allow-network [--expected-sha256 HEX] [--dry-run]
                                  Download a pinned local LLM for the
                                  opt-in secondary validator. See
                                  SAFETY_CHECKLIST.md before flipping
                                  llm_validate.enabled to true.

Categories: customer, ip, email, fqdn, path, domain_user, mac, guid, credential
`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function prompt(q: string): Promise<string> {
  process.stdout.write(q);
  for await (const line of console) {
    return line;
  }
  return '';
}

function padRow(cols: string[], widths: number[]): string {
  return cols.map((c, i) => c.padEnd(widths[i])).join('  ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
