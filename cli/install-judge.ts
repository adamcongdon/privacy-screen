/**
 * `install-judge` CLI — set up the opt-in LLM secondary validator.
 *
 * Pure-logic core extracted from `cli/PrivacyScreen.ts` so it's unit-testable
 * without touching the network or the filesystem. The CLI shim calls
 * `runInstallJudge(args, defaultDeps())` and prints the returned message.
 *
 * Subcommands:
 *   install-judge --model <name> --allow-network [--expected-sha256 <hex>]
 *                              [--dest <path>] [--dry-run]
 *   install-judge --runtime    — locate `llama-server` or print install hints
 *
 * Safety:
 *   - Refuses any network call without `--allow-network`.
 *   - Refuses destination paths outside the safe model directory
 *     (`${homedir()}/.privacy-screen/models/`), preventing path traversal.
 *   - Verifies SHA-256 if `--expected-sha256` is supplied; otherwise prints
 *     the computed hash so the user can verify out-of-band.
 *   - Never modifies `PRIVACY_CONFIG.yaml` directly — prints the YAML
 *     snippet the user should add. Respects user control over config files.
 */

import { createHash } from 'crypto';
import { join, normalize, resolve, sep } from 'path';

// ─── Public API ───────────────────────────────────────────────────────────────

/** Result envelope returned to the CLI. `ok=false` means the CLI should exit 1. */
export interface InstallJudgeResult {
  ok: boolean;
  /** Lines to print on stdout. */
  message: string;
  /** Lines to print on stderr (errors/warnings). Optional. */
  stderrMessage?: string;
}

/** Injectable dependencies. Production uses `defaultDeps()`; tests override. */
export interface InstallJudgeDeps {
  fetchImpl: typeof fetch;
  homedir: () => string;
  fsExists: (path: string) => boolean;
  fsMkdir: (path: string) => void;
  fsWrite: (path: string, data: Uint8Array) => void;
  /** Streaming + atomic install support (for #72: no full-RAM buffer, .partial + rename after hash). */
  fsCreateWriteStream: (path: string) => {
    write: (data: Uint8Array | Buffer) => void;
    end: (cb?: () => void) => void;
    on: (event: 'finish' | 'error', cb: (err?: Error) => void) => void;
  };
  fsRename: (oldPath: string, newPath: string) => void;
  fsUnlink: (path: string) => void;
  /** Returns `which llama-server` output or null if not on PATH. */
  whichLlamaServer: () => string | null;
  /** OS for runtime-install hints. */
  platform: () => NodeJS.Platform;
}

/** Pinned model manifest. Bump these when upstream changes. */
export interface ModelEntry {
  url: string;
  expectedSizeBytes: number; // approximate, used for sanity check + UI
  expectedSha256: string; // JDG-04: pinned; verified by default (flag overrides)
  description: string;
}

export const MODELS: Record<string, ModelEntry> = {
  'qwen2.5-1.5b': {
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    expectedSizeBytes: 986_000_000,
    expectedSha256:
      '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370',
    description:
      'Qwen2.5-1.5B-Instruct Q4_K_M — Apache 2.0, 29 languages, ~1 GB on disk',
  },
};

/** Run the install-judge command. Pure function; never touches I/O directly. */
export async function runInstallJudge(
  args: string[],
  deps: InstallJudgeDeps,
): Promise<InstallJudgeResult> {
  const parsed = parseArgs(args);

  if (parsed.mode === 'runtime') {
    return runRuntime(deps);
  }
  if (parsed.mode === 'model') {
    return runModel(parsed, deps);
  }
  return {
    ok: false,
    stderrMessage:
      'install-judge: pass either --model <name> or --runtime\n' +
      `Known models: ${Object.keys(MODELS).join(', ')}\n`,
    message: '',
  };
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  mode: 'model' | 'runtime' | 'invalid';
  modelName?: string;
  allowNetwork: boolean;
  expectedSha256?: string;
  destOverride?: string;
  dryRun: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    mode: 'invalid',
    allowNetwork: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--runtime') {
      out.mode = 'runtime';
    } else if (a === '--model') {
      out.mode = 'model';
      out.modelName = args[i + 1];
      i++;
    } else if (a === '--allow-network') {
      out.allowNetwork = true;
    } else if (a === '--expected-sha256') {
      out.expectedSha256 = args[i + 1];
      i++;
    } else if (a === '--dest') {
      out.destOverride = args[i + 1];
      i++;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

// ─── `--runtime` mode ─────────────────────────────────────────────────────────

function runRuntime(deps: InstallJudgeDeps): InstallJudgeResult {
  const found = deps.whichLlamaServer();
  if (found) {
    return {
      ok: true,
      message:
        `✅ llama-server found at ${found}\n` +
        `   Ready to run when llm_validate.enabled: true and a model is installed.\n`,
    };
  }
  const platform = deps.platform();
  const hint = runtimeInstallHint(platform);
  return {
    ok: false,
    stderrMessage:
      '⚠️  llama-server is not on PATH.\n\n' +
      hint +
      '\nAfter installing, re-run: bun cli/PrivacyScreen.ts install-judge --runtime\n',
    message: '',
  };
}

function runtimeInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return (
      'Install on macOS:\n' +
      '  brew install llama.cpp\n' +
      '  # or build from source: https://github.com/ggml-org/llama.cpp\n'
    );
  }
  if (platform === 'linux') {
    return (
      'Install on Linux:\n' +
      '  # Debian/Ubuntu: apt install llama-cpp-tools (when packaged) or build from source\n' +
      '  # Arch: pacman -S llama.cpp\n' +
      '  # From source: https://github.com/ggml-org/llama.cpp\n'
    );
  }
  if (platform === 'win32') {
    return (
      'Install on Windows:\n' +
      '  # winget install --id=ggml-org.llama-cpp\n' +
      '  # or download a prebuilt release: https://github.com/ggml-org/llama.cpp/releases\n'
    );
  }
  return (
    `Install for ${platform}:\n` +
    '  See https://github.com/ggml-org/llama.cpp\n'
  );
}

// ─── `--model` mode ───────────────────────────────────────────────────────────

async function runModel(
  parsed: ParsedArgs,
  deps: InstallJudgeDeps,
): Promise<InstallJudgeResult> {
  const name = parsed.modelName;
  if (!name || !(name in MODELS)) {
    return {
      ok: false,
      stderrMessage:
        `install-judge: unknown model "${name ?? ''}".\n` +
        `Known models: ${Object.keys(MODELS).join(', ')}\n`,
      message: '',
    };
  }
  const entry = MODELS[name];
  const safeDir = modelDir(deps);
  const destPath = parsed.destOverride
    ? resolveDestSafe(parsed.destOverride, safeDir)
    : join(safeDir, `${name}.gguf`);

  if (destPath === null) {
    return {
      ok: false,
      stderrMessage:
        `install-judge: --dest must be inside ${safeDir} (path traversal refused)\n`,
      message: '',
    };
  }

  if (parsed.dryRun) {
    return {
      ok: true,
      message: planMessage(name, entry, destPath, parsed),
    };
  }

  if (!parsed.allowNetwork) {
    return {
      ok: false,
      stderrMessage:
        `install-judge: refusing to fetch ${entry.url} without --allow-network.\n` +
        '  This command performs a one-time network download of ~1 GB.\n' +
        '  Re-run with --allow-network to consent, or --dry-run to preview.\n',
      message: '',
    };
  }

  if (!deps.fsExists(safeDir)) {
    deps.fsMkdir(safeDir);
  }

  let body: Uint8Array;
  try {
    const res = await deps.fetchImpl(entry.url, { method: 'GET' });
    if (!res.ok) {
      return {
        ok: false,
        stderrMessage: `install-judge: HTTP ${res.status} from ${entry.url}\n`,
        message: '',
      };
    }
    const buf = await res.arrayBuffer();
    body = new Uint8Array(buf);
  } catch (err) {
    return {
      ok: false,
      stderrMessage: `install-judge: download failed: ${errMessage(err)}\n`,
      message: '',
    };
  }

  // JDG-04: size sanity band + default sha verify from manifest (flag is override).
  if (!parsed.expectedSha256) {
    const expectedSize = entry.expectedSizeBytes;
    const sizeTolerance = Math.floor(expectedSize * 0.05);
    if (Math.abs(body.byteLength - expectedSize) > sizeTolerance) {
      return {
        ok: false,
        stderrMessage:
          'install-judge: size sanity band violation — refusing to write file.\n' +
          `  expected: ~${expectedSize} (±5%)\n` +
          `  actual:   ${body.byteLength}\n`,
        message: '',
      };
    }
  }

  const actualSha = sha256Hex(body);
  const expectedSha = parsed.expectedSha256 ?? entry.expectedSha256;
  if (expectedSha && actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    return {
      ok: false,
      stderrMessage:
        'install-judge: SHA-256 mismatch — refusing to write file.\n' +
        `  expected: ${expectedSha}\n` +
        `  actual:   ${actualSha}\n` +
        '  (pinned in manifest; pass --expected-sha256 to override for testing/custom)\n',
      message: '',
    };
  }

  try {
    deps.fsWrite(destPath, body);
  } catch (err) {
    return {
      ok: false,
      stderrMessage: `install-judge: write failed at ${destPath}: ${errMessage(err)}\n`,
      message: '',
    };
  }

  return {
    ok: true,
    message: successMessage(name, destPath, actualSha, body.byteLength),
  };
}

function planMessage(
  name: string,
  entry: ModelEntry,
  destPath: string,
  parsed: ParsedArgs,
): string {
  const shownSha = parsed.expectedSha256 ?? entry.expectedSha256;
  return (
    `── Dry run: install-judge --model ${name} ──\n` +
    `  Source:   ${entry.url}\n` +
    `  Size:     ~${Math.round(entry.expectedSizeBytes / 1_000_000)} MB\n` +
    `  Dest:     ${destPath}\n` +
    `  Network:  ${parsed.allowNetwork ? 'allowed' : '⚠️  requires --allow-network'}\n` +
    `  SHA-256:  ${shownSha} ${parsed.expectedSha256 ? '(override)' : '(pinned in manifest)'}\n` +
    `\nRe-run without --dry-run when ready.\n`
  );
}

function successMessage(
  name: string,
  destPath: string,
  sha: string,
  sizeBytes: number,
): string {
  return (
    `✅ Model installed.\n\n` +
    `  Model:    ${name}\n` +
    `  Path:     ${destPath}\n` +
    `  Size:     ${Math.round(sizeBytes / 1_000_000)} MB\n` +
    `  SHA-256:  ${sha}\n\n` +
    `Next:\n` +
    `  1. Confirm llama-server is on PATH:\n` +
    `       bun cli/PrivacyScreen.ts install-judge --runtime\n` +
    `  2. Add this to your PRIVACY_CONFIG.yaml:\n\n` +
    `       llm_validate:\n` +
    `         enabled: true\n` +
    `         model_path: ${destPath}\n\n` +
    `  3. Start the server (the hook talks to it):\n` +
    `       bun run start\n` +
    `\nSee SAFETY_CHECKLIST.md → "LLM secondary validation" for the full enable flow.\n`
  );
}

// ─── Internals ────────────────────────────────────────────────────────────────

function modelDir(deps: InstallJudgeDeps): string {
  return join(deps.homedir(), '.privacy-screen', 'models');
}

/**
 * Resolve `dest` and confirm it sits inside `safeDir`. Returns null if the
 * caller is trying to escape the safe directory via `..`, symlink-shaped
 * paths, or an absolute path elsewhere. Pure string operations — does not
 * follow symlinks; that's a defense for the next layer.
 */
function resolveDestSafe(dest: string, safeDir: string): string | null {
  const absolute = resolve(dest);
  const normalizedDest = normalize(absolute);
  const normalizedSafe = normalize(safeDir);
  if (
    normalizedDest === normalizedSafe ||
    normalizedDest.startsWith(normalizedSafe + sep)
  ) {
    return normalizedDest;
  }
  return null;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
