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

### WHO CHOOSES A SKILL: the model, from the descriptions (rewritten 2026-07-26)

**The rule.** Every turn except the first build turn offers `load_skill`, and the model selects from the
index of `name — description` that `buildSkillsIndex` bakes into the cached prompt. That is the
agentskills.io contract, it is how Claude Code behaves, and it is the only version of this subsystem that
is a *skill system* rather than a prompt library with extra steps. **The FIRST BUILD TURN is the sole
exception**: its brief is machine-written against two named skills (`bt-landing` + `bt-design`), so they
are inlined and skill tools are off — one mechanism per turn, never two.

⚠️ **Called "the creation turn" until 2026-07-29 (SPEC §4.4a).** Project creation no longer contacts a
model at all — it clones, installs and serves the starter — so the exception now attaches to the message
the *user* sends out of New Project mode, identified exactly as before by `CREATION_BRIEF_MARKER`
(`isFirstBuildTurn`). Nothing about the exception's mechanics or its measurements changed; a reader
looking for "the creation turn" in this document should read "the first build turn" throughout.

**What was there before, and why it had to go.** A `Record<string, string[]>` of substrings, hardcoded
in *this* repo, matched against the user's text; whatever it picked was inlined, and `load_skill` was
then **withdrawn**. Every failure was silent:

| Defect | Consequence |
|---|---|
| `'ui'` matched as a bare substring | `"why is my build failing"` (b‑**ui**‑ld) inlined `bt-design` — 24KB into the cached prefix, on a debugging question |
| 3 of 10 synced skills had **no entry** | `bt-copycat`, `bt-plan`, `bt-execute` could never load — two-thirds of the product's own spec → plan → execute workflow |
| `description` was never read | The index calls it THE trigger ("fix it in the repo and resync"); fixing it changed nothing |
| Table lives in the wrong repo | Skills are authored in `babylontoolkit/skills`; a new skill needed a TypeScript edit here to become reachable |
| The invoked skill's **body** was routing input | `/bt-spec` inlined `bt-landing` because bt-spec's SKILL.md contains the word "landing" — and routing is sticky, so it stayed wrong all conversation |
| The tool was withdrawn when the table fired | The prompt said "Call `load_skill(name)`" while the tool was absent — a dangling instruction, and a wrong choice was uncorrectable |

**Measured live, same `/bt-spec add a collectible gem pickup counter to the HUD` request:**

| | Keyword table | Model-driven |
|---|---|---|
| Skills loaded | bt-spec, bt-design, **bt-landing** | **bt-spec** |
| Doc blocks routed | 10 (incl. `racing-system`, `demo-rotator`) | **2** |
| Cache-write tokens | 216,614 | **157,626** |
| Credits | 378 | **263** |

And the case the old design could not express at all — *"Break the gem pickup counter spec into ordered
implementation tasks"*, plain English, no slash: the model loaded **`bt-plan`** by description. The old
table had no `bt-plan` entry, and mapped the word "plan" to `bt-spec` — the wrong skill, inlined, with
the tool then withdrawn.

### A skill the model loaded STAYS loaded for the conversation

**The last real gap against Claude Code**, closed 2026-07-26 (`stickyLoadedSkills`). In Claude Code a
loaded skill remains in context for the session — you pay for it once. Our tool loop is server-side and
internal, so the call and its result never enter the saved conversation: a skill loaded on turn 1 was
**gone on turn 2**, and a spec → plan → execute workflow paid a fresh round trip *every turn* for
instructions it had already been given.

Skills the model chose are now carried in the **cached prefix** of later turns, which makes this cheaper
than the thing it copies (Claude Code re-sends a loaded skill inside an uncached conversation; we re-send
it at cache-read rates). The source is the conversation itself — `api.agent.ts` annotates each assistant
message with `skillsLoaded`, the AI SDK posts annotations back, and the transcript store persists them —
so no database round trip is added to the hot path to learn something the request already contains.

**Three properties, each of which fails as a bigger bill rather than an error:**

- **Append-only, first-seen order** (`MAX_STICKY_SKILLS = 3`). A name inserted at the FRONT shifts every
  byte behind it and rewrites the prefix at 2×. ⚠️ Capping must TRUNCATE the tail, never rotate.
- **Read from the FULL message list, never the compacted one.** The windowed history would make the set
  SHRINK as a conversation ages — breaking append-only on the turn the window slides.
- **The budget counts NEW loads, not carried ones** (`loadedThisTurn` vs `loaded` in `tools.ts`).
  Charging for carried skills would mean a conversation holding its cap could never load another — the
  "withdraw the tool" failure returning through the budget.

**Measured live**, same conversation:

| Turn | Steps | Prefix tokens | Credits | Wall clock |
|---|---|---|---|---|
| model loads `bt-plan` itself | 2 | 303,368 | 528 | 122s |
| follow-up, `bt-plan` carried | **1** | **169,273** | **276** | 17s |
| follow-up, `bt-plan` carried | **1** | **169,273** | **274** | 7s |

`toolRounds: 0` on both follow-ups: the round trip is gone, not merely cheaper.

### Why this does not re-buy the six-round pathology

The pathology is real and is recorded below. It is bounded now by a **budget on skill BODIES**
(`MAX_SKILL_LOADS = 2`, enforced inside `execute` in `tools.ts`), not by taking the tool away. Past the
cap `load_skill` refuses and tells the model to proceed with what it has. Four things make the old
failure unreachable, none of which existed when it was measured:

1. **`MAX_SKILL_LOADS`** — six rounds of skill loading cannot happen regardless of what the model wants.
2. **The already-loaded guard** — a re-request returns one sentence, not a 15–25KB body. This is what
   the "five identical calls" thrash below actually needed.
3. **Nothing is inlined on an ordinary turn**, so the contradictory state that produced *every* recorded
   thrash — a skill in the prefix under *"ALREADY LOADED — do NOT call load_skill"* **while the tool was
   offered** — no longer exists.
4. **The index says to load skills BEFORE writing.** A `load_skill` call is ~50 tokens of JSON; what
   made the measurement below cost 29,173 output tokens was the model starting the artifact, wanting a
   skill mid-draft, and discarding the draft, at 5× input rate, repeatedly. *Loading is cheap;
   interleaving loading with writing is not.*

Measured live after the rewrite: `load_skill` for `bt-plan` cost **one round and 122 output tokens**
(6.5s), then the answer. ⚠️ **A tool round is still not free here** — it re-processes the whole cached
prefix (~151k tokens: 0.1× warm, but a 2× WRITE on a cold KIE backend, which is most of that turn's 528
credits). That is the reason the budget is a hard ceiling of 2 rather than a suggestion.

### The pathology itself, kept because it is why the guards exist

Offering the tool **while a skill was already inlined** and telling the model not to use it is a trap,
not a redundancy — measured three times:

- **Creation turn, tools available.** Prompt said "never load a skill on a creation turn"; the model called `load_skill` four times anyway. Removing the tools took the build from **468s → 114s**. *(The first build turn still runs this way —
  it is the same marker-carrying turn, sent by the user since 2026-07-29 rather than fired by creation.)*
- **Edit turn, tools available.** `bt-design` pre-loaded under a heading reading *"ALREADY LOADED — do NOT call load_skill"*; the model called `load_skill('bt-design')` **five times in a row**, each answered "already loaded, proceed with the task". Six rounds, ~11,000 output tokens, two minutes — then an **empty response**. Charged 405 credits. *(The already-loaded guard now answers in one sentence, and nothing is inlined on an ordinary turn.)*
- **Edit turn, only `read_skill_resource` available.** It thrashed on *that* instead: six rounds, 160s, empty response again. **The trap is the tool, not which tool** — and the trap is specifically a tool offered against inlined content that says not to use it.

**Resolved limitation.** Under the old design a pre-loaded turn could not read a skill's **bundled
resources** — only its instructions were inlined — so `bt-design`'s "read `references/3d-hero-scroll.md`
before writing code" was unfollowable, and the skill block deliberately did not even list the paths
(naming a file the model has no tool to open is a dangling instruction). With `load_skill` and
`read_skill_resource` available on every ordinary turn, that limitation is gone: paths come back with
the skill, and the model can fetch what it needs.

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
