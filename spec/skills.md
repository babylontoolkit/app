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
- `read_skill_resource` resolves strictly via the version's `resources_manifest` (exact-match path lookup; no filesystem semantics → no traversal class of bugs). Unknown skill/path → friendly tool_result error string, never an exception. It takes a LIST of paths — N resources must cost one round trip, not N.
- Loop cap: 6 tool rounds per generation (config); on cap, proceed with what's loaded.
- Loaded bodies appended as separate `cache_control` blocks (repeat loads within TTL are cheap).
- We NEVER execute `scripts/` server-side. Skills that ship project files direct the agent to emit them as normal file actions into the user's WebContainer.

### A tool argument the model can get wrong is validated in `execute`, NEVER in the schema

The AI SDK validates tool arguments against the zod schema **before `execute` runs**, and a violation throws `InvalidToolArgumentsError` — which **aborts the stream and kills the generation**. The user is billed for everything spent up to that point and gets a zod dump back.

Both of these happened on real edit turns, against the real model:

| Constraint | The call that killed it | Cost |
|---|---|---|
| `paths: z.array(z.string()).min(1)` | `read_skill_resource({skill: 'bt-design', paths: []})` | 185s, 15,881 output tokens, 497 credits |
| `name: z.string()` (required) | `load_skill({})` | 45s, ~3,500 output tokens |

Models emit degenerate tool calls; they always will. The defect is not the model's — it is that we made a *recoverable* mistake *fatal*. Every tool argument is therefore `.optional()`, and `execute` returns a sentence the model reads and corrects on its next step, inside the same generation. Constrain the schema only where a violation is genuinely impossible. `tools.spec.ts` pins this.

### Pre-loading and the tool loop are ALTERNATIVES, never both at once

A skill is reached **either** by pre-loading it into the cached prefix **or** by the model fetching it with a tool. Offering the tool while telling the model not to use it is a trap, not a redundancy — measured three times:

- **Creation turn, tools available.** Prompt said "never load a skill on a creation turn"; the model called `load_skill` four times anyway. Removing the tools took the build from **468s → 114s**.
- **Edit turn, tools available.** `bt-design` pre-loaded under a heading reading *"ALREADY LOADED — do NOT call load_skill"*; the model called `load_skill('bt-design')` **five times in a row**, each answered "already loaded, proceed with the task". Six rounds, ~11,000 output tokens, two minutes — then an **empty response**. Charged 405 credits.
- **Edit turn, only `read_skill_resource` available** (kept so bundled files stayed reachable). It thrashed on *that* instead: six rounds, 160s, empty response again. **The trap is the tool, not which tool.**

With tools off, the same edit takes **29–39s** and produces a correct patch. So `allowTools = !isCreationTurn && preloaded.length === 0 && !slash` — tools exist only for the turn the keyword router could not anticipate, the only turn where they can help.

**Known limitation (recorded, not hidden).** On a pre-loaded turn the model cannot read a skill's **bundled resources** — only its instructions are inlined. `bt-design` bundles 101KB of hero-scroll templates (~25k tokens) and its body says to read one before writing hero-scroll code. Inlining all of it on every design turn is the wrong trade for the one turn in fifty that wants it. If that workflow becomes important, the fix is a **resource-level router** that inlines the few files a request actually implies — *not* handing the tool back.

Corollary, and the reason the block does not even list the resource paths: naming a file the model has no tool to open is not information, it is a dangling instruction, and it will spend the whole turn trying to follow it.

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
