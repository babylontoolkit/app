/**
 * The ceiling on a project's SOURCE, shared by every path that stores one (SPEC §5, §4.5.4c, §4.8).
 *
 * ## Why this is one constant and not two
 *
 * The platform stores a user's source in exactly two places, for two different reasons:
 *
 *   - the **working copy** (§4.5.4c) — one per project, crash recovery, written on every checkpoint;
 *   - the **remix seed** (§4.8) — one per published project, so a stranger's Remix has something to clone.
 *
 * They are different features with different lifetimes, and they were given different caps: 256MB and
 * 75MB, each picked on its own and neither checked against the other. That combination is incoherent in
 * a way nothing detects — the platform will happily hold a 200MB project for recovery, let the owner
 * publish it, and then decline to store the seed, so the game is public, playable, and **permanently
 * un-remixable**. The owner is told nothing, because a publish is not allowed to fail over its seed.
 *
 * A project the platform is willing to hold for recovery is a project it is willing to hold for remix.
 * One number expresses that; two numbers merely happened to agree until someone tuned one of them.
 *
 * ⚠️ The **build** cap (`BUILD_MAX_MB`) is deliberately NOT this number — a built `dist/` is a different
 * artifact with different economics (it is served to the public on every play, not read once on a
 * clone). Only source belongs here.
 *
 * Both caps stay independently tunable (`WORKING_COPY_MAX_MB`, `REMIX_SEED_MAX_MB`) — an operator may
 * have a reason to split them. This is the DEFAULT they share, so they cannot silently drift apart
 * without someone typing a number.
 */
export const DEFAULT_PROJECT_SOURCE_MAX_MB = 256;
