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
- **Client-supplied byte uploads** → a size cap before the write (`MAX_BUILD_BYTES`/`MAX_BUILD_FILES` in `share/publish.ts`, `MAX_SEED_BYTES` in `share/seed-store.ts`).

## Auth is in the handler — NEVER in `withSecurity`

`app/lib/security.ts` `withSecurity` does **method-check + per-IP rate-limit + security headers ONLY**. It has no auth option. One used to exist (`requireAuth?: boolean`), was never wired to anything, and made every route that passed it LOOK protected while remaining anonymous. **A wall that lives in a boolean nobody reads is worse than no wall.** Do not re-add it. Rate-limiting is a secondary layer; the verified-user guard is the wall.

## The closed set (2026-07-19)

All inherited, all originally unauthenticated, all now guarded + pinned by `outbound-auth.spec.ts` (21 handlers → 401 with zero outbound `fetch` when unauthenticated):

| Route | Was | Now |
|---|---|---|
| `api.git-proxy.$` | open forward-proxy to any host; SSRF; logged `authorization`; streamed unbounded | verified user; per-hop `assertPublicUrl`; no secret logging |
| `api.github-user` | anonymous; `get_token` returned platform `GITHUB_TOKEN` | verified user; `get_token` returns caller's cookie token only |
| `api.github-stats`, `api.github-branches` | anonymous; platform-token fallback | verified user |
| `api.gitlab-branches`, `api.gitlab-projects` | anonymous; caller-supplied `gitlabUrl` (SSRF) | verified user; `isAllowedUrl(gitlabUrl)` |
| `api.netlify-user`, `api.vercel-user`, `api.supabase-user` | anonymous; platform-token fallback | verified user |
| `api.netlify-deploy`, `api.vercel-deploy` | anonymous; unbounded 60× poll loops | verified user |
| `api.supabase.query`, `api.supabase.variables`, `api.supabase` | anonymous passthroughs | verified user |
| `api.projects.$id.publish` (build) | uncapped S3 write | `MAX_BUILD_BYTES`/`MAX_BUILD_FILES` + header pre-reject |
| remix seed / self-remix (`putRemixSeed`) | uncapped S3 write | `MAX_SEED_BYTES` |

## By-design, NOT holes

- `BILLING_ENFORCED=false` (unmetered beta): generations and media renders proceed on an empty balance — intentional posture, flip the flag to enforce (`spec/billing.md`).
- A single in-flight generation may go one-generation negative — we never kill a running generation for balance (§4.2.1); it self-corrects at the next gate.

## When you add a route

Ask: does it fetch, proxy, deploy, or write caller bytes? If yes, it is a spend path — add `denyUnlessVerified`, add the SSRF/URL wall if it fetches a caller-influenced target, add a size cap if it stores bytes, and add it to `outbound-auth.spec.ts`. Grep the handler for `denyUnlessVerified`; do not assume a wrapper authed it.
