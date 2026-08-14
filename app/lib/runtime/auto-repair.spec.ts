/**
 * Self-healing (§4.2.7) — the decision to spend the user's credits WITHOUT them asking.
 *
 * That framing is the whole reason these tests exist. Every `repair: false` branch below is money not
 * spent; every `repair: true` is a generation the user never requested and will be billed for. Both
 * directions fail silently:
 *
 * - too eager (no window, no source check, no cap) → the agent bills the user to "fix" breakage they
 *   caused themselves, or loops on a build it cannot repair;
 * - too shy (a broken guard, a lost attempt count) → the feature quietly does nothing, which is
 *   exactly the state this code was written to end.
 */
import { describe, expect, it } from 'vitest';
import { decideAutoRepair, repairMessage, MAX_CLIENT_REPAIRS, REPAIR_WINDOW_MS, type RepairWatch } from './auto-repair';
import type { ActionAlert } from '~/types/actions';

const NOW = 1_000_000;

const previewError: ActionAlert = {
  type: 'preview',
  title: 'Build failed',
  description: "Failed to resolve import './BoostController'",
  content: 'src/scripts/RaceMode.ts:12:8: ERROR: Could not resolve "./BoostController"',
  source: 'preview',
};

const armed: RepairWatch = { generationId: 'gen_abc', attempt: 0, until: NOW + REPAIR_WINDOW_MS };

const decide = (over: Partial<Parameters<typeof decideAutoRepair>[0]> = {}) =>
  decideAutoRepair({ alert: previewError, watch: armed, isLoading: false, now: NOW, ...over });

describe('auto-repair — when it FIRES', () => {
  it('repairs a build error the generation we just ran caused', () => {
    const decision = decide();

    expect(decision.repair).toBe(true);
    expect(decision).toMatchObject({ repairOf: 'gen_abc', repairAttempt: 1 });
  });

  /*
   * `repairOf` is what tells the SERVER this is a repair rather than a fresh request — which is what
   * escalates the effort (repair → `high`) and counts the turn against the cap. Lose it and the repair
   * silently degrades into an ordinary, cheaper, dumber turn.
   */
  it('names the generation being repaired, so the server can escalate and count it', () => {
    const decision = decide({ watch: { ...armed, generationId: 'gen_xyz' } });

    expect(decision).toMatchObject({ repair: true, repairOf: 'gen_xyz' });
  });

  it('sends the compiler output as errors — not as a chat message', () => {
    const decision = decide();

    expect(decision).toMatchObject({
      errors: [previewError.description, previewError.content],
    });

    // The visible message is a sentence; the model gets the error text via the body.
    expect(repairMessage(1)).not.toContain('ERROR:');
  });

  /* Attempt 2 escalates on the server to `xhigh`. It must be reachable, or the cap is the only rung. */
  it('escalates to attempt 2 after a repair that did not fix it', () => {
    const decision = decide({ watch: { ...armed, attempt: 1 } });

    expect(decision).toMatchObject({ repair: true, repairAttempt: 2 });
    expect(repairMessage(2)).toContain('still failing');
  });
});

describe('auto-repair — when it must NOT fire (each of these is unauthorised spend)', () => {
  /*
   * THE CAP. Two failed repairs means the agent is thrashing, not fixing — a third turn spends the
   * user's credits to watch it thrash again. Without this the loop is unbounded: every repair produces
   * a new generation, which produces a new build error, which produces a new repair, forever.
   */
  it('stops after the cap, and hands back to the user', () => {
    const decision = decide({ watch: { ...armed, attempt: MAX_CLIENT_REPAIRS } });

    expect(decision).toEqual({ repair: false, disarm: true });
  });

  /*
   * A terminal error is usually the USER's own command (`npm run something`). Repairing it uninvited is
   * presumptuous — and billable.
   */
  it('ignores terminal errors — only a Vite compile error is ours to fix', () => {
    const decision = decide({ alert: { ...previewError, source: 'terminal' } });

    expect(decision.repair).toBe(false);
  });

  /*
   * THE WINDOW. Vite recompiles just after the last file action lands, so our error arrives shortly
   * after the stream ends. An error an hour later is the user breaking their own project, and charging
   * them to "fix" it would be indefensible.
   */
  it('ignores an error that arrives after the window — that break is not ours', () => {
    const decision = decide({ now: NOW + REPAIR_WINDOW_MS + 1 });

    expect(decision).toEqual({ repair: false, disarm: true });
  });

  it('does nothing when no generation is being watched', () => {
    expect(decide({ watch: null }).repair).toBe(false);
  });

  /* Firing mid-stream would interleave two generations against one project — §4.12's corruption case. */
  it('never fires while a generation is already streaming', () => {
    expect(decide({ isLoading: true }).repair).toBe(false);
  });

  it('does not fire on an error with no text — the model would have nothing to act on', () => {
    const decision = decide({ alert: { ...previewError, description: '', content: '' } });

    expect(decision).toEqual({ repair: false, disarm: true });
  });
});

/*
 * The loop terminates. This is the property that matters most: an agent that cannot fix a build must
 * stop trying and give the user their money back's worth of control, rather than grinding.
 */
describe('auto-repair terminates', () => {
  it('runs at most MAX_CLIENT_REPAIRS turns for one broken generation', () => {
    let watch: RepairWatch = { generationId: 'gen_1', attempt: 0, until: NOW + REPAIR_WINDOW_MS };
    const fired: number[] = [];

    for (let i = 0; i < 10; i++) {
      const decision = decideAutoRepair({ alert: previewError, watch, isLoading: false, now: NOW });

      if (!decision.repair) {
        break;
      }

      fired.push(decision.repairAttempt);

      // The repair produces a new generation, which fails to build again. Attempt carries forward.
      watch = { generationId: `gen_${i + 2}`, attempt: decision.repairAttempt, until: NOW + REPAIR_WINDOW_MS };
    }

    expect(fired).toEqual([1, 2]);
  });
});

/**
 * 🔴 MID-CREATION, THE NEXT PHASE OWNS THE ERROR (§4.4e, `_specs/phased-creation_plan.md` trap 2).
 *
 * Phased creation makes a compile error between phases NORMAL rather than a defect: the frontend
 * phase writes a landing page importing art the ART phase has not rendered yet, so Vite is correctly
 * red for the whole gap. Every other guard in this file passes on that alert — it is `source:
 * 'preview'`, inside the window, under the attempt cap — so without this the agent would fire a
 * repair turn between every pair of phases, billing the user to fix what the next phase was about to
 * fix and colliding with it for the one-generation-per-project claim (§4.12).
 */
describe('auto-repair — while a creation plan is still running', () => {
  it('does not repair an error the next phase is going to fix', () => {
    expect(decide({ creationPlanActive: true })).toEqual({ repair: false, disarm: false });
  });

  /**
   * ⚠️ THE LOAD-BEARING HALF: `disarm: false`, never `true`.
   *
   * The watch must SURVIVE the gap. The last phase's output is real code with no phase after it to
   * fix a mistake, and that is precisely the turn self-healing exists for — so a disarm here would
   * trade a spurious repair for no repair at all, which is the more expensive direction and silent.
   */
  it('leaves the watch armed, so the last phase is still covered', () => {
    expect(decide({ creationPlanActive: true })).toMatchObject({ disarm: false });
  });

  /**
   * The CONTROL. Without it this block passes for a guard that disabled auto-repair permanently —
   * the cheerful way a "stop repairing" fix goes green while removing the feature.
   */
  it('repairs again as soon as the plan is finished', () => {
    expect(decide({ creationPlanActive: false }).repair).toBe(true);
    expect(decide().repair).toBe(true);
  });
});
