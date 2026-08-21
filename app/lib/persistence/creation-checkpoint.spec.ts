/**
 * 🔴 THE CREATION BASELINE, AND THE TWO WAYS IT GOES QUIET (owner, 2026-08-15).
 *
 * A project is CREATED before any AI turn runs (§4.4a): clone the pinned starter, scaffold the §4.4b
 * class, install, serve — no model contacted. The first build is a turn the user sends. So there is a
 * real moment, before a single credit of generation is spent, where the project is a known-good stock
 * starter, and `Chat.client.tsx` checkpoints it there.
 *
 * That checkpoint has been written since 2026-07-29 **by accident**. It was added to fix a CONVERSATION
 * problem — a created-but-unbuilt project uploaded no transcript, so `/api/chats` returned `[]` and the
 * sidebar read "No previous conversations" beside an open chat — and the fix reused `checkpointProject`,
 * which happens to write files too. Every word of commentary at the call site was about the transcript.
 * The baseline was a side effect of a side effect.
 *
 * `creation-no-agent-request.spec.tsx` pins the CALL (and now its label). It cannot pin what the call
 * does, because it mocks `checkpointProject` outright. This file covers the other half: that the label
 * actually reaches the snapshot, and that the skip branch is not silent.
 *
 * ## Why a SOURCE scan
 *
 * `checkpointProject` is a `useCallback` closed over module state inside `useChatHistory`, a hook that
 * cannot be constructed without a database, a workbench store and a sandbox. That is the same reason
 * `plan-my-brief-wiring.spec.ts` and `first-build-turn.spec.ts` scan source, and the same rule applies
 * here: comment-stripped, scoped by brace matching, and every extraction proven to have found the real
 * code BEFORE anything is asserted about it.
 *
 * ⚠️ A source scan proves a name appears in the right place. It cannot prove the value is correct at
 * runtime. It is here because the alternative — no check at all on the half that survived three weeks
 * unnamed — is how this class of defect keeps shipping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATION_CHECKPOINT_LABEL } from './local-snapshots';

const RAW = readFileSync(join(process.cwd(), 'app/lib/persistence/useChatHistory.ts'), 'utf8');

/**
 * Comments are documentation, not behaviour — and this function carries several hundred words of it,
 * including prose that names `createLocalSnapshot`, `label` and `toast` while explaining why each
 * exists. An unstripped scan would find every rule below "wired" from the commentary alone.
 */
const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Brace-match the body of a `{ … }` that opens at or after `from`. */
function block(source: string, from: number): string {
  const open = source.indexOf('{', from);

  if (open === -1) {
    return '';
  }

  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }

  return '';
}

/**
 * The real `checkpointProject` callback — every rule below is about something inside it.
 *
 * ⚠️ Anchored on `=> {`, NOT on the declaration. The signature now contains a brace of its own
 * (`options?: { label?: string }`), so brace-matching from the declaration returns the TYPE LITERAL —
 * an 18-character string that every `toContain` below then fails against. Caught by the controls on the
 * first run, which is exactly what they are for: the assertion that fired was "found the real callback",
 * not one of the rules, so the failure named the scanner rather than blaming the code.
 */
const CHECKPOINT = block(SOURCE, SOURCE.indexOf('=> {', SOURCE.indexOf('const checkpointProject = useCallback')));

/**
 * The guard that returns without writing anything. Scoped to the `if (!pid || !db || …)` statement, so
 * a `toast` somewhere else in the function cannot satisfy the assertion about THIS branch.
 *
 * ⚠️ Includes the CONDITION, not just the body — `block()` returns what is between the braces, so a
 * slice of the body alone cannot be shown to be the right branch (its control would be asserting `!pid`
 * against text that structurally cannot contain it). Second scanner defect the controls caught here.
 */
const SKIP_BRANCH = (() => {
  const start = CHECKPOINT.indexOf('if (!pid || !db');

  return start === -1 ? '' : CHECKPOINT.slice(start, start + block(CHECKPOINT, start).length + 200);
})();

/** The `createLocalSnapshot(...)` call that writes the checkpoint — argument list only. */
const SNAPSHOT_CALL = (() => {
  const start = CHECKPOINT.indexOf('createLocalSnapshot(');

  if (start === -1) {
    return '';
  }

  const end = CHECKPOINT.indexOf(');', start);

  return end === -1 ? '' : CHECKPOINT.slice(start, end);
})();

describe('CONTROLS — the scanner is looking at the real code', () => {
  /* Without these, every assertion below passes vacuously against an empty or misread extraction. */
  it('reads the file it claims to', () => {
    expect(RAW.length).toBeGreaterThan(10_000);
    expect(SOURCE).toContain('const checkpointProject = useCallback');
  });

  it('found the real checkpointProject callback', () => {
    expect(CHECKPOINT.length).toBeGreaterThan(500);
    expect(CHECKPOINT).toContain('createLocalSnapshot(');
    expect(CHECKPOINT.length).toBeLessThan(SOURCE.length);
  });

  it('found the skip branch, and it is a small slice of the function', () => {
    expect(SKIP_BRANCH).toContain('!pid');
    expect(SKIP_BRANCH.length).toBeGreaterThan(50);
    expect(SKIP_BRANCH.length).toBeLessThan(CHECKPOINT.length / 2);
  });

  it('found the createLocalSnapshot argument list, and it really is just the call', () => {
    expect(SNAPSHOT_CALL).toContain('projectId');
    expect(SNAPSHOT_CALL.length).toBeLessThan(300);
  });

  /* A name this file would never legitimately find, proving the matchers can return false. */
  it('does not match something that is not there', () => {
    expect(CHECKPOINT).not.toMatch(/createLocalSnapshotThatDoesNotExist/);
  });
});

describe('the label reaches the snapshot', () => {
  /**
   * 🔴 `checkpointProject` must ACCEPT a label.
   *
   * Without the parameter the call site's `{ label: CREATION_CHECKPOINT_LABEL }` is silently ignored —
   * TypeScript would reject it, but only while the signature and the call disagree; widen the signature
   * to `unknown` or drop the argument and the whole thing compiles and does nothing.
   */
  it('takes an options argument carrying a label', () => {
    const signature = CHECKPOINT.slice(0, CHECKPOINT.indexOf('=>') + 2);
    expect(SOURCE).toMatch(/const checkpointProject = useCallback\(\s*async \(messageId: string, options\?/);
    expect(signature.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 And it must FORWARD it into the write.
   *
   * This is the mutation `creation-no-agent-request.spec.tsx` structurally cannot see: it mocks
   * `checkpointProject`, so the label can be accepted at the boundary and dropped one line later, and
   * the creation test stays green. The row lands unlabelled, §4.12's restore list shows an anonymous
   * checkpoint where the baseline should be, and nothing throws.
   */
  it('forwards it into createLocalSnapshot', () => {
    expect(SNAPSHOT_CALL).toMatch(/label:\s*options\?\.label/);
  });

  /**
   * CONTROL — the ordinary checkpoint fields are still there. Without this, a change that passed ONLY
   * the label (dropping `files` or `messageId`) satisfies the rule above while writing a checkpoint that
   * restores nothing, or one that cannot anchor "restore to before this change".
   */
  it('CONTROL: still writes the files and the message id', () => {
    expect(SNAPSHOT_CALL).toContain('files');
    expect(SNAPSHOT_CALL).toContain('messageId');
    expect(SNAPSHOT_CALL).toContain('projectId');
  });
});

describe('a skipped checkpoint is loud', () => {
  /**
   * 🔴 The two branches that return without writing — no project id, no database — mean undo and crash
   * recovery do not cover this change. They were `logger.warn` only, which is invisible to the person
   * whose work it is.
   *
   * That is the same shape T17c already had to fix one screen below (a console-only `.catch(() => {})`
   * that cost a 500-credit creation on kill-recovery) and the same rule as §4.5.4b: a failed save is
   * never silent. Every OTHER failure path in this function already toasts; these two were the holdout.
   */
  it('tells the user, not just the console', () => {
    expect(SKIP_BRANCH).toMatch(/toast\.(error|warn)\(/);
  });

  /**
   * ⚠️ Guarded, or it nags. The checkpoint fires after every generation, so an unguarded toast in a
   * session whose database never opened is one dismissed-unread warning per turn.
   */
  it('at most once per project per session', () => {
    expect(SKIP_BRANCH).toMatch(/warnedCheckpointFailure/);
  });

  /**
   * CONTROL — the idempotency case must stay QUIET. `lastCheckpointedMessage.current === messageId` is
   * the guard doing its job on a re-render, not a failure; toasting there would fire on ordinary,
   * entirely healthy turns. This is the assertion that stops "make it loud" from becoming "make it
   * loud always", which is how a real warning gets trained into noise.
   */
  it('CONTROL: the already-checkpointed case stays silent', () => {
    const inner = block(SKIP_BRANCH, SKIP_BRANCH.indexOf('if (lastCheckpointedMessage.current !== messageId)'));

    expect(inner).toMatch(/toast\./);

    /* The toast is INSIDE the "not already checkpointed" guard, so the re-render path reaches nothing. */
    expect(inner.length).toBeLessThan(SKIP_BRANCH.length);
  });
});

describe('the label constant', () => {
  /**
   * Exported and shared rather than typed twice: the writer and both specs have to agree about it
   * forever, and a re-typed literal is how the two drift while every test stays green.
   */
  it('is a real, human-readable string', () => {
    expect(CREATION_CHECKPOINT_LABEL).toMatch(/\S/);
    expect(CREATION_CHECKPOINT_LABEL.length).toBeLessThan(40);
  });

  /**
   * 🔴 Not a `kind`. `LocalSnapshot.kind` is a closed union (`'top-up'`) that changes how the row is
   * TREATED — `selectRestoreTarget` resolves `'after'` to the last match because of it, and
   * `amendLocalSnapshot` refuses any row that is not one. A baseline is an ordinary checkpoint that
   * happens to have a name; expressing it as a kind would silently opt it into amend-in-place and make
   * the starter overwritable by the next top-up.
   */
  it('is a label, not a snapshot kind', () => {
    expect(RAW).not.toMatch(/kind\?:\s*'top-up'\s*\|\s*'creation'/);
  });
});
