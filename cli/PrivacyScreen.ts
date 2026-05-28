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

import { VocabStore, defaultDbPath } from '../src/vocab';
import { ScrubMap } from '../src/scrub-map';
import { scrubText } from '../src/scrubber';

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
  const { readFileSync } = await import('fs');
  const text = readFileSync('/dev/stdin', 'utf-8');
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
  if (result.hasCredentials) {
    console.log('\n⚠️  CREDENTIAL DETECTED — would block in hook.');
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

function printHelp(): void {
  console.log(`
PrivacyScreen CLI — PII vocabulary & review queue management

Commands:
  review               Interactive triage of pending review items
  vocab list [-c CAT]  List vocabulary entries (optionally filter by category)
  vocab forget <val>   Remove a vocabulary entry
  allowlist add <pat>  Never tokenize this pattern (--regex for regex match)
  scrub                Read stdin, scrub, print result + token map
  stats [days=7]       Show daily redaction activity

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
