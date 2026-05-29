/**
 * Singleton VocabStore + ScrubMap for the server process.
 *
 * Server code uses one shared store across all request handlers so that
 * vocab state is consistent within a process. The ScrubMap is loaded from
 * SQLite once and incrementally updated as new tokens are minted.
 */

import { VocabStore, defaultDbPath } from '../../src/vocab';
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

/** Reset the singletons — used in tests and after a settings reload. */
export function resetVocab(): void {
  if (_vocab) {
    try { _vocab.close(); } catch { /* ignore */ }
  }
  _vocab = null;
  _map = null;
}
