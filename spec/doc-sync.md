# spec/doc-sync.md — Doc-Sync Subsystem (governs SPEC §4.3)

Consumes the Agent Reference repo into versioned, cached system prompts. The GitHub repos stay authored exactly as today; the platform only ever reads snapshots.

## Sources

- Root: `https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md`
- Sub-docs (baked into base prompt, in order): `references/node-esm.md` (primary style), `references/scene-components.md`, `references/react-framework.md`, `references/ui-design-system.md`, `references/training-reference.md`
- On-demand block: `references/shader-materials.md`
- Excluded: `references/classic.md` (UMD — platform is ESM-only)
- Skills index text is supplied by the skills subsystem (spec/skills.md) and concatenated into the base prompt.

## Build pipeline — `buildSystemPrompt()`

1. Fetch all sources (fail the build on any HTTP error or empty body — never activate a partial prompt).
2. Record source repo `main` HEAD SHA (`source_commit_sha`).
3. Assemble in fixed order: reference docs → skills index → platform sections (action protocol rules, hard constraints, self-healing directive, skill-usage directive — templates live in `app/lib/.server/prompt/sections/*.md`, versioned with the code).
4. Compute `content_hash` (sha256 of the base prompt) **and `build_hash`** — a fingerprint over the base prompt **plus every on-demand block and declaration file**. If `build_hash` is identical to the active version's → no-op (log "unchanged").
5. Insert `prompt_versions` row; activation is a separate step.

**The no-op keys on `build_hash`, never on `content_hash`.** `content_hash` covers only the cached prefix, but on-demand blocks and declarations are persisted by the same insert this no-op skips. Keyed on `content_hash`, an edit confined to a system doc (`training/components/*.md`, `shader-materials.md`, a `.d.ts`) was fetched, reported `ok: true, status: "unchanged"`, and discarded — the active version kept the old blobs and served stale docs indefinitely. Nothing threw. Both hashes are kept and distinct: `content_hash` is the identity of the cached prefix (§4.2.8), `build_hash` is the identity of the build.

`build_hash` is **derived from the per-artefact content hashes, never stored** — bodies are content-addressed, so the version record already contains every hash it needs. A persisted copy could drift from the blobs it claims to describe.

The version id is suffixed with `build_hash`, not `content_hash`: the id's timestamp resolves only to the second, so two versions sharing a base prompt would otherwise collide and overwrite each other's record.

```sql
prompt_versions: id, content, content_hash, source_commit_sha,
                 skills_set_hash, created_at, is_active (exactly one true)
-- build_hash is derived at read time from the stored blob refs, not a column.
```

## Activation, rollback, refresh

- `POST /api/admin/prompt/refresh` → build → on success, activate new version atomically (single UPDATE flipping `is_active`). On failure: previous version stays active; alert.
- `POST /api/admin/prompt/activate {version_id}` → rollback/forward to any version.
- Phase 3: GitHub webhook (push to `main` of agent or skills repos, HMAC-verified) triggers refresh. Debounce 60s (batch multi-file pushes).
- List endpoint for the admin UI: versions with hash, SHA, created_at, active flag, generation counts.

## Runtime

- The agent proxy reads the active version once per request (cache the row in memory with a short TTL + invalidation on activate).
- Sent as the first system block with `cache_control: {type:"ephemeral"}`. On-demand blocks (shaders; loaded skills per spec/skills.md) are appended as **separate** cached blocks so the base prefix stays byte-identical.
- Zero GitHub dependency at generation time — hard rule.

## Observability

- Alert on: build failure, webhook signature failure, active-version age > 30d (staleness nudge).
- Every `generations` row stores `prompt_version_id`; admin dashboard charts cost/error-rate per prompt version to catch doc regressions.

## Tests (money/safety paths)

- Build fails on missing/empty doc; activation atomicity; rollback restores byte-identical content; webhook HMAC rejection.
- **The no-op, both directions** — it must still skip an identical rebuild (a spurious version churns the cached prefix, §4.2.8), AND it must rebuild when ONLY an on-demand block or declaration changed, with the active version serving the new bytes. This path is silent in both failure modes: a stale-doc bug reports `ok: true` and throws nothing, so these tests are the only thing between a docs push and an agent quietly working from last week's reference.
