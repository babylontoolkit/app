/**
 * MARKDOWN-ONLY WRITES DO NOT ARM THE DONE-GATE (tool-loop D11).
 *
 * Art direction writes only `SPEC.md` / `DESIGN.md`. Gating that forces a `check_game` which cannot
 * verify anything (~90 s per build). These drive the REAL overlay through the SAME derivation the proxy
 * uses (`doneGateWriteFacts`) into the real `decideNextSegment`, so a proxy that went back to
 * `overlay.writes.size > 0` for the gate is the only way to make them lie.
 *
 * The outcome half is pinned too: `overlay.writes` (what the no-files refund reads) still counts a
 * markdown-only phase as having produced files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideNextSegment, DEFAULT_TOOL_LOOP_CONFIG, type SegmentFacts } from './tool-loop';
import { doneGateWriteFacts, WorkspaceOverlay, writeArmsDoneGate } from './workspace-tools';

function decide(overlay: WorkspaceOverlay, lastCheck: SegmentFacts['lastCheck'] = null, planTurn = false) {
  return decideNextSegment(
    {
      aborted: false,
      budgetHit: false,
      finishReason: 'stop',
      lastStepToolCalls: 0,
      segmentsRun: 1,
      ...doneGateWriteFacts(overlay, planTurn),
      lastCheck,
      nudgesUsed: 0,
      breakerTripped: false,
      lastStepInputTokens: 1000,
    },
    DEFAULT_TOOL_LOOP_CONFIG,
  );
}

describe('writeArmsDoneGate', () => {
  it('markdown never arms it, whatever the case or folder', () => {
    for (const path of ['SPEC.md', 'DESIGN.md', 'docs/notes.MD', 'README.Md', ' src/x.md ']) {
      expect(writeArmsDoneGate(path), path).toBe(false);
    }
  });

  it('everything else does — source, styles, config, package.json', () => {
    for (const path of ['src/scripts/Kart.ts', 'src/pages/Home.css', 'package.json', 'index.html', 'src/md.ts']) {
      expect(writeArmsDoneGate(path), path).toBe(true);
    }
  });
});

describe('the done-gate, driven through the real overlay', () => {
  it('md-only → done without a gate', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('SPEC.md', '# spec');
    overlay.write('DESIGN.md', '# design');

    expect(decide(overlay)).toEqual({ kind: 'done' });
  });

  it('md + ts → gate', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('SPEC.md', '# spec');
    overlay.write('src/scripts/Kart.ts', 'export {}');

    expect(decide(overlay).kind).toBe('gate');
  });

  it('a package.json (what run_command writes) → gate', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('package.json', '{}');

    expect(decide(overlay).kind).toBe('gate');
  });

  it('a markdown write AFTER a passing check does not un-verify it', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('src/scripts/Kart.ts', 'export {}');

    const check = { ok: true, afterWriteSeq: overlay.gateWriteSeq };
    overlay.write('DESIGN.md', '# design');

    expect(decide(overlay, check)).toEqual({ kind: 'done' });

    /* CONTROL: a source write after the check does. */
    overlay.write('src/scripts/Kart.ts', 'export const x = 1;');
    expect(decide(overlay, check).kind).toBe('gate');
  });

  it('a Plan turn never arms it', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('src/scripts/Kart.ts', 'export {}');

    expect(decide(overlay, null, true)).toEqual({ kind: 'done' });
  });

  it('the OUTCOME still counts a markdown-only phase as having written files', () => {
    const overlay = new WorkspaceOverlay({});
    overlay.write('SPEC.md', '# spec');

    expect(overlay.writes.size > 0).toBe(true);
    expect(doneGateWriteFacts(overlay, false).wroteThisTurn).toBe(false);
  });
});

/* The proxy is where the facts are assembled; `runAgentGeneration` cannot be built in a unit test. */
describe('the proxy derives the gate facts through doneGateWriteFacts', () => {
  const proxy = readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8');

  it('spreads doneGateWriteFacts into the segment facts', () => {
    expect(proxy).toMatch(/\.\.\.doneGateWriteFacts\(overlay, Boolean\(discussNote\)\)/);
  });

  it('never derives wroteThisTurn from every write', () => {
    expect(proxy).not.toMatch(/wroteThisTurn:[^\n]*writes\.size/);
  });

  it('CONTROL: the outcome still reads every write', () => {
    expect(proxy).toMatch(/const turnWroteFiles = \(\) => emittedAction \|\| \(overlay\?\.writes\.size \?\? 0\) > 0/);
  });
});
