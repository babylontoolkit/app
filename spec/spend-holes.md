# spec/spend-holes.md — Owner-cost spend holes & the outbound-route wall (governs SPEC §5, §2.1b)

## What a "spend hole" is

A route that spends the **owner's** money without billing the caller. Two kinds, and both fail SILENTLY — nothing throws, and the token/usage count often goes DOWN, which reads as a cheaper turn:

1. **Token spend** — a path that reaches the paid LLM key (Anthropic) or media key (KIE) unmetered. These are the catastrophic ones (a leaked/ungated key bills uncapped). They are all closed and pinned: `/api/agent` + `/api/enhancer` gate credits BEFORE the model and choose the model server-side; `/api/chat` + `/api/llmcall` fail closed (`upstream-routes.ts`, 404); KIE media debits before the render (`spec/billing.md`, migration 0009). See `upstream-routes.spec.ts`, `media.spec.ts`.
2. **Resource spend** — a path that costs the owner **bandwidth/egress, S3 storage, or a third-party API quota/token** even though it never touches the LLM. These are the inherited bolt.diy plumbing routes, and they are the subject of this doc.

## The standing rule

**Every server route that reaches OUT (fetches, proxies, deploys) or writes client-supplied bytes to storage is a spend path on the owner's resources.** It requires, at minimum, a **verified user**, enforced INSIDE the handler:

```ts
const denied = await denyUnlessVerified(request, context); // app/lib/.server/http.ts
if (denied) return denied;                                  // → 401/403, before any fetch/write
```

Additional walls by shape:

- **Any caller-influenced fetch URL** → the shared SSRF guard `app/lib/.server/net/ssrf.ts` (`assertPublicUrl`: string allow-list via `~/utils/url` + a DNS-rebinding resolve check), re-run on **every redirect hop**, never just the first. Used by `/api/web-search` and `/api/git-proxy`.
- **A caller-supplied base URL** (e.g. GitLab `gitlabUrl`) → `isAllowedUrl` before it is fetched.
- **A platform secret** (provider token) → a route may **act** on it, never **emit** it. `get_token`-style endpoints return only the caller's OWN cookie token, never the server-env fallback (the export-api-keys rule, SPEC §5).
- **Client-supplied byte uploads** → a size cap before the write (`BUILD_MAX_MB`/`BUILD_MAX_FILES` in `share/publish.ts`, `REMIX_SEED_MAX_MB` in `share/seed-store.ts`, `WORKING_COPY_MAX_MB` in `projects/working-copy.ts`). All env-configurable; every refusal names the size, the limit and the variable. ⚠️ Caps that hold the SAME content must share a default (`storage/limits.ts`) or they drift apart silently — see CLAUDE.md.

## Auth is in the handler — NEVER in `withSecurity`

`app/lib/security.ts` `withSecurity` does **method-check + per-IP rate-limit + security headers ONLY**. It has no auth option. One used to exist (`requireAuth?: boolean`), was never wired to anything, and made every route that passed it LOOK protected while remaining anonymous. **A wall that lives in a boolean nobody reads is worse than no wall.** Do not re-add it. Rate-limiting is a secondary layer; the verified-user guard is the wall.

## The vendor-named set (2026-07-19) — ⚠️ once called "the closed set"; see the next section for why that was wrong

All inherited, all originally unauthenticated, all now guarded + pinned by `outbound-auth.spec.ts`:

| Route | Was | Now |
|---|---|---|
| `api.git-proxy.$` | open forward-proxy to any host; SSRF; logged `authorization`; streamed unbounded | verified user; per-hop `assertPublicUrl`; no secret logging |
| `api.github-user` | anonymous; `get_token` returned platform `GITHUB_TOKEN` | verified user; `get_token` returns caller's cookie token only |
| `api.github-stats`, `api.github-branches` | anonymous; platform-token fallback | verified user |
| `api.gitlab-branches`, `api.gitlab-projects` | anonymous; caller-supplied `gitlabUrl` (SSRF) | verified user; `isAllowedUrl(gitlabUrl)` |
| `api.netlify-user`, `api.vercel-user`, `api.supabase-user` | anonymous; platform-token fallback | verified user |
| `api.netlify-deploy`, `api.vercel-deploy` | anonymous; unbounded 60× poll loops | verified user |
| `api.supabase.query`, `api.supabase.variables`, `api.supabase` | anonymous passthroughs | verified user |
| `api.projects.$id.publish` (build) | uncapped S3 write | `BUILD_MAX_MB`/`BUILD_MAX_FILES` + derived header pre-reject |
| remix seed / self-remix (`putRemixSeed`) | uncapped S3 write | `REMIX_SEED_MAX_MB` (shares its default with the working copy) |

## The set that sweep MISSED (2026-07-20)

⚠️ **The heading above said "the closed set". It was not closed.** The 2026-07-19 sweep enumerated routes named after **vendors** — `github-*`, `gitlab-*`, `netlify-*`, `vercel-*`, `supabase*`, `git-proxy` — and guarded every one. Routes named after **subsystems** were never looked at, and `outbound-auth.spec.ts` then encoded that blind spot *as coverage*: 21 green assertions about a set that never contained the holes.

| Route | Was | Now |
|---|---|---|
| `api.system.git-info` | 🔴 anonymous, and preferred the PLATFORM `GITHUB_ACCESS_TOKEN` **over the caller's own** — a `curl` listed the operator's private repos, gists, orgs | verified user; caller's header/cookie token ONLY, env never consulted |
| `api.github-template` | 🔴 anonymous; caller-chosen `?repo=`; platform-token zipball fetch + up to 3 unbounded S3 writes per request | verified user |
| `api.models` | 🔴 anonymous; caller-COOKIE `baseUrl` (SSRF via keyless Ollama/LMStudio); cookie-keyed cache evictable to re-hit keyed providers on our quota | verified user (`baseUrl` stays caller-shaped by design — BYOK, §4.6.1) |
| `api.system.diagnostics` | 🟠 anonymous egress ping to GitHub/Netlify on our IP; disclosed which platform tokens are configured | verified user |
| `api.bug-report` | 🟠 anonymous GitHub issue creation on `GITHUB_BUG_REPORT_TOKEN`, behind only an in-process per-IP counter that resets on deploy | verified user |

**Still open, flagged not approved:** `api.git-info` and `api.system.disk-info` run `execSync` (fixed commands, no caller input reaches the shell) and disclose host branch/commit/disk facts anonymously. Recorded in `PUBLIC_BY_DESIGN` with FLAGGED reasons rather than silently blessed.

**The structural fix — `outbound-enumerate.spec.ts`, and it is DEFAULT-DENY.** It walks `app/routes/` itself: every `api.*` handler must reference a wall, or appear in `PUBLIC_BY_DESIGN` with a written reason. A route added tomorrow is covered the moment it lands.

⚠️ The first draft of that spec tried to be clever — scan for `fetch(`, require a guard on whatever matched. It found three of the five and **missed `api.github-template` and `api.models`**, which reach out through helpers (`fetchTemplateFiles`, `LLMManager`) and contain no literal `fetch(`. **A detector that decides which routes matter reproduces the original bug with a regex instead of a person.** Being open is the thing you justify, not being closed.

The two specs are complements and neither replaces the other — verified by mutation: a new unguarded route fails `outbound-enumerate` (source scan), a guard whose *result is ignored* passes it and fails `outbound-auth` (behavioural).

## By-design, NOT holes

- `BILLING_ENFORCED=false` (unmetered beta): generations and media renders proceed on an empty balance — intentional posture, flip the flag to enforce (`spec/billing.md`).
- A single in-flight generation may go one-generation negative — we never kill a running generation for balance (§4.2.1); it self-corrects at the next gate.

## When you add a route

Default-deny: add `denyUnlessVerified` at the top of the handler unless you can write down why the route must be public — `outbound-enumerate.spec.ts` will fail until you do one or the other. Then: an SSRF/URL wall if it fetches a caller-influenced target, a size cap if it stores bytes, and a case in `outbound-auth.spec.ts` so the wall is proven *reached*, not merely present. Grep the handler for `denyUnlessVerified`; do not assume a wrapper authed it.

**Do not name the route after its vendor and assume that is the category.** The 2026-07-19 sweep swept by vendor name and the five subsystem-named routes above sat unguarded for a year behind a green test suite.

## The lesson, generalised

Both times, the defect was not the missing guard — it was the **enumeration that decided which routes to look at**. A hand-written list, then a regex: each drew a boundary in good faith, and each reported success about everything outside it. A check whose scope is a judgement call inherits that judgement's blind spots and then launders them as coverage.

The fix is to make the *safe* state the one that requires no judgement: enumerate everything, deny by default, and make each exception cost someone a written sentence. Same family as `wastedOutput`, `tool_rounds`, `charsPerOutputToken`, the thinking estimate, and the doubled `finishReason` — **a metric or check defined in terms of the failure it expects reports success on the failure it does not.**
