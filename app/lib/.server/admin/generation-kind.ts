/**
 * `gen_` OR `med_` — and the admin report has been counting the second as the first.
 *
 * The `generations` table holds two kinds of row. A GENERATION is a model turn: it has a prompt, a
 * duration, tool rounds, a finish reason and a step log. A MEDIA render (§4.16, `media/service.ts`)
 * is a paid image or video task that shares the table because it shares the ledger's foreign key —
 * it has none of those things, and none of them are zero either; they are absent.
 *
 * `refundKind()` has split the two since the refund report was written. `buildUsageReport` never did,
 * so on a platform where a landing-page pass commissions eight images, the §4.10 dashboard counted
 * eight extra "generations" that could not fail, could not run a tool round and had no model to
 * attribute — quietly diluting `failureRate`, `avgToolRounds` and `byModel` on the exact screen an
 * operator uses to decide whether the platform is healthy.
 *
 * ⚠️ The rule lives HERE, in one place, for `isSecretPath`'s reason: it existed in the admin layer
 * already, and the fix for "one of the two callers has it" is never a second copy.
 */
export type GenerationKind = 'generation' | 'media' | 'other';

export function generationKind(id: string | undefined): GenerationKind {
  if (id?.startsWith('gen_')) {
    return 'generation';
  }

  if (id?.startsWith('med_')) {
    return 'media';
  }

  /*
   * ⚠️ NOT 'generation'. An id whose prefix we do not recognise is an unknown, and defaulting it into
   * the generation bucket is how a future third row type silently joins the numbers an operator
   * trusts — the same "absent must not read as a default" rule `provider` and `status_kind` follow.
   */
  return 'other';
}
