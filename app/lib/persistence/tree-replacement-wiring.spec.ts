/**
 * The tree-replacement suppression is a CHAIN, and three of its links had no test (§4.13a T15).
 *
 * The signal travels: `applyBranchTree` → `markTreeReplaced` → the `treeReplacedProject` store →
 * `Chat.client.tsx`'s `useChat` body → `AgentRequest.treeReplaced` → `checkManifestShrink`. Both ENDS
 * were well covered (`apply-branch-tree.spec.ts` proves the mark is made; `request-invariants.spec.ts`
 * proves the flag suppresses and re-baselines) and the WIRE BETWEEN THEM was not: a verifier deleted
 * the `clearTreeReplaced()` call, and separately hardcoded the proxy's read to `false`, and the full
 * 7,754-test suite stayed green for both.
 *
 * The two failures are opposite and both silent:
 *
 *   - **the clear is lost** → the flag sticks for the life of the tab, so INV-3(b) — which T15
 *     PROMOTED from a record to an alert precisely because this suppression exists — is muted forever
 *     for that project. The guard is present, green, and reporting nothing;
 *   - **the proxy read is lost** → every branch switch pages someone, which is the week-one noise the
 *     suppression was built to prevent, and a muted channel is the same as no guard.
 *
 * ⚠️ These are SOURCE SCANS, stated as such. The chain crosses a React component and a server route,
 * and neither can be imported in a unit test (`Chat.client.tsx` pulls in the whole workbench;
 * importing `proxy.ts` boots the provider registry). A scan cannot prove the wire carries the right
 * value — the two end specs do that — but it can prove the wire is still ATTACHED, which is the
 * regression that just went undetected twice. Same instrument and same reasoning as
 * `budgets-wiring.spec.ts`, whose header records that every seam took its budgets optionally, so a
 * proxy that forgot one produced a healthy generation silently running on the default.
 *
 * The recorded lesson this is written against: *"a function-only spec cannot see a caller whose units
 * are wrong"* — the `retryThinkingMode` off-by-one, where both sides documented themselves correctly
 * in isolation and nothing asserted the sequence between them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Comments stripped, for `no-client-token.spec.ts`'s reason: these files EXPLAIN the wire by name. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const code = async (file: string) => stripComments(await fs.readFile(path.resolve(process.cwd(), file), 'utf8'));

const CHAT = 'app/components/chat/Chat.client.tsx';
const PROXY = 'app/lib/.server/agent/proxy.ts';
const APPLY = 'app/lib/persistence/apply-branch-tree.ts';

describe('the tree-replacement suppression is still wired end to end', () => {
  it('applyBranchTree marks the replacement', async () => {
    const source = await code(APPLY);

    expect(source).toMatch(/markTreeReplaced\(projectId\)/);
  });

  it('the chat sends it in the agent request body', async () => {
    const source = await code(CHAT);

    // Computed from the store...
    expect(source).toMatch(/isTreeReplaced\(treeReplacedFor,\s*activeProjectId\)/);

    // ...and actually placed in the body, which is the half a computed-but-unused value would pass.
    expect(source).toMatch(/^\s*treeReplaced,\s*$/m);
  });

  /**
   * 🔴 CLEARED ON FINISH — the link whose deletion muted the alert permanently with nothing failing.
   *
   * The `onFinish` placement is asserted, not merely the call's existence: clearing at SEND time
   * races the very request meant to carry the flag, so a `clearTreeReplaced()` that moved into the
   * submit handler would satisfy a bare "is it called?" scan and break the feature in the other
   * direction.
   */
  it('the chat clears it when a generation FINISHES, not when one is sent', async () => {
    const source = await code(CHAT);
    const at = source.indexOf('onFinish:');

    expect(at, 'onFinish not found — this scan is reading nothing').toBeGreaterThan(-1);

    const clearAt = source.indexOf('clearTreeReplaced()');

    expect(
      clearAt,
      'clearTreeReplaced() is gone — the suppression would stick for the life of the tab',
    ).toBeGreaterThan(-1);

    /* Within the first ~80 lines after `onFinish:` — i.e. in that handler, not somewhere else. */
    expect(clearAt).toBeGreaterThan(at);
    expect(source.slice(at, clearAt).split('\n').length).toBeLessThan(80);
  });

  it('the proxy reads it off the request and hands it to the invariant', async () => {
    const source = await code(PROXY);

    expect(source).toMatch(/checkManifestShrink\([^)]*treeReplaced:\s*request\.treeReplaced === true/s);
  });

  it('the request type declares it, so a sender cannot be silently ignored', async () => {
    const source = await code(PROXY);

    expect(source).toMatch(/treeReplaced\?:\s*boolean;/);
  });

  /**
   * 🔴 THE CONTROLS. Every assertion above is a regex over a file, and a regex that cannot fail is
   * the failure mode this whole file exists to catch one level down. Each scan is proven to be able
   * to MISS: a symbol that does not exist must not match, and the comment strip must really strip
   * (these files name the wire in their doc comments, so a scan reading unstripped source would pass
   * for a deleted implementation whose explanation survived).
   */
  it('the scans can fail', async () => {
    const chat = await code(CHAT);
    const proxy = await code(PROXY);

    expect(chat).not.toMatch(/markTreeReplacedEverywhere/);
    expect(proxy).not.toMatch(/checkManifestShrinkTwice/);

    // The strip is real: `apply-branch-tree.ts` names `mountProjectFiles` ONLY in a comment.
    expect(await code(APPLY)).not.toMatch(/mountProjectFiles/);
    expect(await fs.readFile(path.resolve(process.cwd(), APPLY), 'utf8')).toMatch(/mountProjectFiles/);
  });
});
