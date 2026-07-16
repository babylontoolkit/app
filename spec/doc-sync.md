# spec/doc-sync.md — Doc-Sync Subsystem (governs SPEC §4.3)

Consumes the Agent Reference repo into versioned, cached system prompts. The GitHub repos stay authored exactly as today; the platform only ever reads snapshots.

## Sources

- Root: `https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md`
- Sub-docs (baked into base prompt, in order): `references/node-esm.md` (primary style), `references/scene-components.md`, `references/react-framework.md`, `references/ui-design-system.md`, `references/training-reference.md`
- On-demand blocks: `references/shader-materials.md`, the 14 `training/components/*.md` system docs, **`training/react/README.md`** (the ~55KB Agentic AI Game Builder reference — routed, never baked), **`references/web-kie-servers.md`** (MCP image/video/texture generation), **`training/playgrounds/01–05`** (example patterns)
- Excluded: `references/classic.md` (UMD — platform is ESM-only); `references/skills-repository.md` (installs skills into the project via `.claude/skills` / plugin marketplaces — another host's mechanism; here the server pre-loads skills into the cached prefix or serves `load_skill`, §4.11); the other `web-app-*.md` / `lovable.md` / `vercel-app-builder.md` host docs (we bake `web-app-generic.md`, §4.3)

### Reachability is an invariant, not a preference

**Every doc a baked reference points at must be baked or routed.** There is no network at generation time, and the platform-identity section tells the model the routing step is complete and never to report a failed fetch — so an unreachable doc does not error, it just gets improvised around, silently, in precisely the area it was meant to cover.

This shipped broken and is worth remembering: `react-framework.md` (baked) said "**always reference**" `training/react/README.md`, `training-reference.md` (baked) listed all five playgrounds under "check for a matching example before writing code from scratch", and the Reference Index routed image generation to `web-kie-servers.md` — **none of the four were synced by any path**. The model was told to always consult a 55KB doc, told it was already inlined, given no way to read it, and told not to mention the failure. `doc-sync.spec.ts` now pins each pointer's target as reachable.

A doc that must NOT reach the model (`classic.md`, `skills-repository.md`) is neutralized **in the platform-identity section**, which is ordered first and declared to override the reference docs. Deleting the pointer at the source is an **agent-repo** change: this codebase consumes those docs and never edits them (§4.3).
- Skills index text is supplied by the skills subsystem (spec/skills.md) and concatenated into the base prompt.

## Build pipeline — `buildSystemPrompt()`

1. Fetch all sources (fail the build on any HTTP error or empty body — never activate a partial prompt).
2. Record source repo `main` HEAD SHA (`source_commit_sha`).
3. Assemble in fixed order: reference docs → skills index → platform sections (action protocol rules, hard constraints, self-healing directive, skill-usage directive — templates live in `app/lib/.server/prompt/sections/*.md`, versioned with the code).
4. Compute `content_hash` (sha256 of the base prompt) **and `build_hash`** — a fingerprint over the base prompt **plus every on-demand block and declaration file**. If `build_hash` is identical to the active version's → no-op: stamp `last_seen_commit_sha` / `last_seen_at` on the active version (step 6) and log "unchanged".
5. Insert `prompt_versions` row; activation is a separate step.
6. **An unchanged build still records what it learned.** Docs move without changing a byte we bake (a commit touching only skill bodies, or an excluded doc like `classic.md`), so `source_commit_sha` drifts behind HEAD by design. `last_seen_commit_sha` is the most recent commit confirmed to rebuild byte-identically; `source_commit_sha` stays the commit the version was FIRST built from. Both are needed: without the observation, a version that is perfectly current is indistinguishable from one whose sync silently never ran, and "is the prompt stale?" has no honest answer. Observation is **not build identity** — it never touches content, hashes, `source_commit_sha`, or the blob refs, which is what makes it safe to write to an otherwise immutable version. Absent on old rows → read as "seen at build time". The refresh response returns it as `confirmedCurrentAt`, because `status: "unchanged"` alone cannot say whether we looked.

**The no-op keys on `build_hash`, never on `content_hash`.** `content_hash` covers only the cached prefix, but on-demand blocks and declarations are persisted by the same insert this no-op skips. Keyed on `content_hash`, an edit confined to a system doc (`training/components/*.md`, `shader-materials.md`, a `.d.ts`) was fetched, reported `ok: true, status: "unchanged"`, and discarded — the active version kept the old blobs and served stale docs indefinitely. Nothing threw. Both hashes are kept and distinct: `content_hash` is the identity of the cached prefix (§4.2.8), `build_hash` is the identity of the build.

`build_hash` is **derived from the per-artefact content hashes, never stored** — bodies are content-addressed, so the version record already contains every hash it needs. A persisted copy could drift from the blobs it claims to describe.

The version id is suffixed with `build_hash`, not `content_hash`: the id's timestamp resolves only to the second, so two versions sharing a base prompt would otherwise collide and overwrite each other's record.

```sql
prompt_versions: id, content, content_hash, source_commit_sha,
                 last_seen_commit_sha, last_seen_at,
                 skills_set_hash, created_at, is_active (exactly one true)
-- build_hash is derived at read time from the stored blob refs, not a column.
-- last_seen_* are the ONLY mutable columns: observation, not build identity.
```

## Activation, rollback, refresh

- `POST /api/admin/prompt/refresh` → build → on success, activate new version atomically (single UPDATE flipping `is_active`). On failure: previous version stays active; alert.
- `POST /api/admin/prompt/activate {version_id}` → rollback/forward to any version.
- Phase 3: GitHub webhook (push to `main` of agent or skills repos, HMAC-verified) triggers refresh. Debounce 60s (batch multi-file pushes).
- List endpoint for the admin UI: versions with hash, SHA, created_at, `last_seen_commit_sha`/`last_seen_at`, active flag, generation counts.

## Runtime

- The agent proxy reads the active version once per request (cache the row in memory with a short TTL + invalidation on activate).
- Sent as the first system block with `cache_control: {type:"ephemeral"}`. On-demand blocks (shaders; loaded skills per spec/skills.md) are appended as **separate** cached blocks so the base prefix stays byte-identical.
- Zero GitHub dependency at generation time — hard rule.

## Observability

- Alert on: build failure, webhook signature failure, **`last_seen_at` older than 30d** (staleness nudge).
- The nudge measures `last_seen_at`, NOT `created_at`. A prompt built 90 days ago and reconfirmed against HEAD this morning is current, not stale — paging on its age trains everyone to ignore the alert. The real staleness is "nobody has checked in a month", which is exactly what `last_seen_at` says.
- Every `generations` row stores `prompt_version_id`; admin dashboard charts cost/error-rate per prompt version to catch doc regressions.

## Tests (money/safety paths)

- Build fails on missing/empty doc; activation atomicity; rollback restores byte-identical content; webhook HMAC rejection.
- **The no-op, both directions** — it must still skip an identical rebuild (a spurious version churns the cached prefix, §4.2.8), AND it must rebuild when ONLY an on-demand block or declaration changed, with the active version serving the new bytes. This path is silent in both failure modes: a stale-doc bug reports `ok: true` and throws nothing, so these tests are the only thing between a docs push and an agent quietly working from last week's reference.
