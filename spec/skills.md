# spec/skills.md — Skills Subsystem (governs SPEC §4.11)

Claude Code-style skill support in the platform chat: the workflow skills in `github.com/babylontoolkit/skills` (bt-spec, bt-plan, bt-design, …) are slash-invocable (`/bt-spec <task>`) and auto-loadable by description. agentskills.io-compliant progressive disclosure; we conform to the open spec, we do not extend it. All repo skills sync and are invocable by default.

## Sync (extends doc-sync)

1. Fetch skills repo at `main` → enumerate top-level skill directories containing `SKILL.md`.
2. Validate each bundle: frontmatter present; `name` lowercase/hyphens, ≤64 chars, matches folder; `description` present, ≤1024 chars; body non-empty. Invalid bundle → **skip + warn** (one bad skill must not block the set); wholesale fetch failure → keep prior set active + alert.
3. Upsert `skills` (by name) + insert `skill_versions` (body, `resources_manifest` of all bundled files, `storage_prefix`); upload `references/`/`scripts/`/assets to S3 under the prefix (spec/hosting.md).
4. Rebuild the skills index text (sorted by name for stable bytes) and hand to doc-sync → new prompt version.
5. Per-skill rollback: activate any prior `skill_versions` row; triggers index rebuild.

## Runtime tools (server agent proxy only)

```json
{"name":"load_skill","description":"Load the full SKILL.md instructions for a skill listed in the Available Skills index. Call before implementing anything in that skill's domain.","input_schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}
{"name":"read_skill_resource","description":"Read a supporting file bundled with a loaded skill (paths come from that skill's instructions).","input_schema":{"type":"object","properties":{"skill":{"type":"string"},"path":{"type":"string"}},"required":["skill","path"]}}
```

- Tool loop lives entirely server-side inside one generation; client stream sees only text + actions.
- `read_skill_resource` resolves strictly via the version's `resources_manifest` (exact-match path lookup; no filesystem semantics → no traversal class of bugs). Unknown skill/path → friendly tool_result error string, never an exception.
- Loop cap: 6 tool rounds per generation (config); on cap, proceed with what's loaded.
- Loaded bodies appended as separate `cache_control` blocks (repeat loads within TTL are cheap).
- We NEVER execute `scripts/` server-side. Skills that ship project files direct the agent to emit them as normal file actions into the user's WebContainer.

## Invocation

**Slash (primary, Phase 1–2 — the point of the subsystem):** `/` in chat autocompletes synced skills (name + description); `/skill-name <args>` injects the skill body with the args as the task.
**Auto (secondary):** index directive in base prompt: "Consult the Available Skills index; call load_skill when a request matches a skill's description; do not load skills irrelevant to the request."

## Metrics & tuning

- `generations.skills_loaded text[]` per generation.
- Admin: loads per skill / 7d, avg token cost per load, generations-in-domain-without-load (needs sampling/heuristic — best effort).
- A skill that never fires almost always has a weak `description` (it's the trigger). Fix in the repo → resync. Explicit `/skill-name` invocation (Phase 4) force-loads regardless.

## Trust model

Platform skills (our repo) are trusted prompt content. Community/user-installed skills are OUT OF SCOPE until a review/moderation model exists — skills are prompt injection surface by construction.

## Tests

Frontmatter validation matrix; invalid-bundle skip; manifest-only resource resolution (reject non-manifest paths); loop cap; index byte-stability (same skill set → same index text).
