/**
 * SRV-05 / #78 — spawn isolation for claude --print (no user hooks / MCP).
 */
import { describe, test, expect } from 'bun:test';
import {
  buildClaudePrintArgs,
  EMPTY_MCP_CONFIG_JSON,
} from '../server/providers/claude-code';

describe('buildClaudePrintArgs isolation (SRV-05 / #78)', () => {
  test('disables user/project/local setting sources (hooks live there)', () => {
    const args = buildClaudePrintArgs({});
    const i = args.indexOf('--setting-sources');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('');
  });

  test('uses strict empty MCP config so user MCP servers do not load', () => {
    const args = buildClaudePrintArgs({});
    expect(args).toContain('--strict-mcp-config');
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(EMPTY_MCP_CONFIG_JSON);
    expect(JSON.parse(EMPTY_MCP_CONFIG_JSON)).toEqual({ mcpServers: {} });
  });

  test('still disables tools and uses print/stream-json', () => {
    const args = buildClaudePrintArgs({ model: 'sonnet', system: 'be brief' });
    expect(args).toContain('--print');
    expect(args).toContain('stream-json');
    const toolsIdx = args.indexOf('--tools');
    expect(args[toolsIdx + 1]).toBe('');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('be brief');
  });

  test('does not pass --bare (would force API key auth and break OAuth)', () => {
    const args = buildClaudePrintArgs({});
    expect(args).not.toContain('--bare');
  });
});
