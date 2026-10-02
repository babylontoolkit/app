/**
 * Which engine runs a turn (`engine-select.ts`, managed-agents-engine plan D9).
 *
 * Exhaustive over every input combination: a wrong `managed` here hands a Plan turn (read-only by
 * guarantee) a write tool, or silently drops a project's MCP tools — neither throws.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEngine } from './config';
import { selectEngineForTurn } from './engine-select';

const ENGINES: AgentEngine[] = ['legacy', 'managed'];
const CHAT_MODES: Array<string | undefined> = [undefined, 'build', 'discuss', 'something-else', ''];
const MCP: boolean[] = [false, true];

describe('selectEngineForTurn', () => {
  for (const engine of ENGINES) {
    for (const chatMode of CHAT_MODES) {
      for (const hasMcpTools of MCP) {
        const expected = engine === 'managed' && chatMode !== 'discuss' && !hasMcpTools ? 'managed' : 'legacy';

        it(`engine=${engine} chatMode=${String(chatMode)} mcp=${hasMcpTools} → ${expected}`, () => {
          expect(selectEngineForTurn({ engine, chatMode, hasMcpTools })).toBe(expected);
        });
      }
    }
  }

  it('a legacy deploy is legacy for every turn (the kill switch)', () => {
    expect(selectEngineForTurn({ engine: 'legacy', chatMode: 'build', hasMcpTools: false })).toBe('legacy');
  });

  it('CONTROL: an ordinary build turn on a managed deploy really is managed', () => {
    expect(selectEngineForTurn({ engine: 'managed', chatMode: 'build', hasMcpTools: false })).toBe('managed');
  });
});
