/**
 * Singleton VocabStore + ScrubMap for the server process.
 *
 * Server code uses one shared store across all request handlers so that
 * vocab state is consistent within a process. The ScrubMap is loaded from
 * SQLite once and incrementally updated as new tokens are minted.
 */

import { VocabStore, defaultDbPath, type InducedPatternRow } from '../../src/vocab';
import { ScrubMap } from '../../src/scrub-map';
import { loadConfig } from '../../src/config';

let _vocab: VocabStore | null = null;
let _map: ScrubMap | null = null;

export function getVocab(): VocabStore {
  if (!_vocab) {
    const cfg = loadConfig();
    const dbPath = cfg.db_path ?? defaultDbPath();
    _vocab = new VocabStore(dbPath);
  }
  return _vocab;
}

export function getMap(): ScrubMap {
  if (!_map) {
    _map = new ScrubMap();
    getVocab().loadIntoMap(_map);
  }
  return _map;
}

let activePatternsCache: { rows: InducedPatternRow[]; compiled: Map<number, RegExp> } | null = null;

export function getActivePatterns(): Array<{ id: number; category: string; confidence: number; rx: RegExp }> {
  if (!activePatternsCache) {
    const rows = getVocab().activePatterns();
    const compiled = new Map<number, RegExp>();
    for (const row of rows) {
      try {
        compiled.set(row.id, new RegExp(row.regex_source, 'g'));
      } catch {
        // malformed stored regex — skip
      }
    }
    activePatternsCache = { rows, compiled };
  }
  return activePatternsCache.rows
    .filter((r) => activePatternsCache!.compiled.has(r.id))
    .map((r) => ({
      id: r.id,
      category: r.category,
      confidence: r.confidence,
      // Return a FRESH RegExp per call — reusing a /g regex across calls is not safe
      rx: new RegExp(activePatternsCache!.compiled.get(r.id)!.source, 'g'),
    }));
}

export function invalidatePatternsCache(): void {
  activePatternsCache = null;
}

/** Reset the singletons — used in tests and after a settings reload. */
export function resetVocab(): void {
  if (_vocab) {
    try { _vocab.close(); } catch { /* ignore */ }
  }
  _vocab = null;
  _map = null;
  activePatternsCache = null;
}
