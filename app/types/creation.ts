/**
 * The one string that tells the server "this turn is a project creation" (SPEC §4.4b, §4.2).
 *
 * Lives here, in a type-only module, because BOTH sides need it and neither may import the other:
 * `app/lib/registry/create-project.ts` (client) writes it into the creation brief, and the agent proxy
 * (server) reads it back to decide how to run the turn.
 *
 * Why the server cares: on a creation turn the brief IS the workflow, so the model has nothing to go
 * shopping for — and letting it try is expensive. Measured, a creation turn that could call `load_skill`
 * spent 350s and 29,173 output tokens across six tool rounds drafting the game, abandoning the draft to
 * fetch a skill, and redrafting. The system prompt already forbids this in words ("Never load a skill on
 * a project-creation turn") and the model did it anyway, four times. So on this turn the capability is
 * removed rather than discouraged.
 */
export const CREATION_BRIEF_MARKER = 'The project has been created and is installing.';
