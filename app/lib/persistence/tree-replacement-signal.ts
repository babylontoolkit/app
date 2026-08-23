/**
 * "The whole file tree was legitimately replaced." (§4.13a, §4.2.8 INV-3(b).)
 *
 * ## Why this exists
 *
 * The request-integrity guard flags a project whose visible file manifest shrinks sharply within one
 * chat, because that is the shape of the measured 2026-08-03 mount race — the model shown seven files
 * of a seventy-eight-file project, on the most expensive generation in the product, and reporting it
 * in plain language while everyone read it as caution.
 *
 * 🔴 **A branch switch is exactly that shape and is correct**, on every single use: 90 files on a
 * feature branch to 60 on the default is a 33% shrink with no delete action anywhere. Without a signal
 * saying so, every branch switch a user makes pages someone — and an alert that fires on a routine
 * operation mutes the channel in week one, which is the same as not having the guard at all. That is
 * why INV-3(b)'s promotion and this signal were required to land together.
 *
 * ## Why it is a store and not a parameter
 *
 * The shrink is only visible on the NEXT generation — the switch itself contacts no model — so the
 * fact has to survive from the moment the tree is replaced until the user's next turn. It rides in the
 * `/api/agent` body like every other per-turn fact, is re-derived and re-baselined server-side, and can
 * only ever SUPPRESS a signal: a tampered or stale value cannot spend a credit, change a model, or
 * reach a file. That is the whole reason it is safe to let a browser assert it.
 *
 * ⚠️ Per PROJECT, not per chat: a project holds many chats (§4.5.6) and the switch replaces the tree
 * for all of them. The server's baseline is per chat, so a switch legitimately suppresses the check on
 * whichever chat asks first — which is correct, because that is the turn that sees the new tree.
 */
import { atom } from 'nanostores';

/**
 * The project whose tree was replaced, and not yet reported.
 *
 * A single slot rather than a set: only one project is open at a time, and a stale entry for a project
 * the user has left would suppress a real signal the next time they open it.
 */
export const treeReplacedProject = atom<string | undefined>(undefined);

/** Record that a tree-replacing operation landed. Called by `applyBranchTree`, and nowhere else. */
export function markTreeReplaced(projectId: string): void {
  treeReplacedProject.set(projectId);
}

/**
 * Should this project's next turn carry the suppression?
 *
 * ⚠️ Takes the store's VALUE rather than reading the atom, and that is not a style choice: the caller
 * is a React component composing the `useChat` body, so it must read through `useStore` to re-render
 * when the flag changes. A helper that read the atom itself would force the component to re-implement
 * the comparison inline — which is what the first draft did, leaving one rule in two places with the
 * exported one unreachable. One rule, one place (`isSecretPath`'s rule).
 *
 * A pure read: it does NOT clear. It runs during render, and a read that mutates would spend the flag
 * on a re-render that never sent anything.
 */
export function isTreeReplaced(replacedProject: string | undefined, projectId: string | undefined): boolean {
  return Boolean(projectId) && replacedProject === projectId;
}

/**
 * Forget the signal — called when a generation FINISHES, not when one starts.
 *
 * ⚠️ On finish rather than on send, and the difference is a real turn: `useChat` composes its body
 * from committed render state, so clearing at send time races the very request that is meant to carry
 * the flag. Clearing one turn late is harmless (the server re-baselines on every call, so at worst one
 * additional legitimate shrink is not reported); clearing one turn early restores the noise this
 * exists to prevent.
 */
export function clearTreeReplaced(): void {
  treeReplacedProject.set(undefined);
}
