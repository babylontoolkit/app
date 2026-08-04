# spec/hosting.md — Hosting & Deployment: AWS (resolves SPEC open question #6)

## Decision

- **App (`app.babylontoolkit.com`): AWS Lightsail Container Service**, deploying the fork's Docker image (bolt.diy ships a Dockerfile). Rationale: the server agent proxy holds long SSE streams through multi-round tool loops (minutes per generation) — an always-on container has no function-duration limits. Lightsail chosen over ECS Fargate to avoid the mandatory ALB cost/ceremony at this scale; migration path to ECS exists if scale demands it. WebContainers are unaffected by host choice (they run in the user's browser).
- **Files: S3 (existing account)** — project snapshots bucket + shared-builds bucket. Supabase's role narrows to **Postgres + Auth + RLS only**; Supabase Storage is not used.
- **Share domain (SPEC §5 isolation requirement): a SEPARATE registrable WILDCARD domain** — `SHARE_DOMAIN`, e.g. `codewrx.app`. Separate domain, not a subdomain of the app's, so user-authored game HTML can never touch app cookies/sessions. **Each published project gets its own label** (`arcade-racer-k7m2p9qx4nrt.<domain>`), which additionally means one published game cannot read another's `localStorage`/`IndexedDB` — a boundary a single flat play origin could not offer. Needs wildcard DNS `*.<domain>` and a wildcard TLS certificate (ACM is free and auto-renewing; a wildcard covers exactly ONE label, which is why the slug and id share one).
  - The readable half is `projects.share_slug`, and it is **decoration with no unique constraint**: identity is the trailing 12-char `share_id`, recovered with `label.slice(-12)`. That is what removes the whole naming problem — fifty "Arcade Racer" projects all get working URLs, with no reservation queue, no squatting policy, no reserved-word deny list, and no link that breaks when a project is renamed.
  - Start by pointing the wildcard at the Lightsail app and letting the existing `ObjectStore` path serve the bytes — it reuses everything and needs no edge function. CloudFront-over-S3 is a later optimisation; note `storage/index.ts` uses ONE bucket with a `builds/` prefix, so a distribution would need an origin path of `/builds`.
  - `PLAY_URL` is RETIRED and refused loudly if set (`resolveShareDomain`) — it named a single flat origin and cannot be reinterpreted as a wildcard base.
- **DNS:** wherever babylontoolkit.com is managed today (Route 53 optional, not required). `app` → CNAME/ALIAS to the Lightsail container endpoint.
- **AVOID for this app:** Amplify Hosting / Lambda SSR and App Runner — Lambda duration limits and App Runner response-buffering behavior are poor fits for multi-minute SSE. Do not migrate the agent proxy onto them.

## Environments

| Env | Lightsail service | Domain | Notes |
|---|---|---|---|
| staging | `btk-builder-staging` (nano/micro) | `staging.app.babylontoolkit.com` | Behind auth wall (Phase 2). Stripe test mode. Own Supabase project + own S3 prefixes/buckets. |
| prod | `btk-builder` (micro/small) | `app.babylontoolkit.com` | Phase 3+. |

## AWS resources checklist

- Lightsail Container Service per env (power: nano→small as needed; scale = bump power/node count).
- S3: `btk-snapshots-{env}` (private; server-only access) and `btk-play-builds-{env}` (private + CloudFront OAC — never public-listable).
- CloudFront (optional, later): distribution per env over the play bucket, wildcard custom domain (separate registrable domain), origin path `/builds`. Host→path routing lives at the server entry (`functions/[[path]].ts` in production, `vite.config.ts`'s `shareHostPlugin` in dev), never in a route — a Remix route cannot decide it should have been a different route, and putting the check in the loader silently served the app's landing page on every vanity host (measured 2026-08-03).
- IAM: one deploy user/role for CI (ECR-less Lightsail push permissions) and one runtime role/credentials for the app (scoped: put/get on the two buckets only). Long-term: least-privilege policies; never account-root keys.
- SSM Parameter Store (or Lightsail container env vars) for secrets: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LICENSE_SERVICE_URL`, `LICENSE_SERVICE_SECRET`, `SESSION_SECRET`, `S3_SNAPSHOTS_BUCKET`, `S3_PLAY_BUCKET`, GitHub webhook secret, admin allowlist.
- CloudWatch alarms: container restarts, 5xx rate; logs shipped to the error-tracking stack (SPEC §5A).

## Deploy steps (Phase 2)

1. Build image in CI (GitHub Actions): `docker build -t btk-builder .`
2. Push to Lightsail: `aws lightsail push-container-image --service-name btk-builder-staging --label app --image btk-builder`
3. Deploy: `aws lightsail create-container-service-deployment` with the container spec (port 5173→80/443 via Lightsail's endpoint, health check on `/healthz`).
4. `/healthz` checks: DB reachable, active prompt version present, S3 credentials valid.
5. Custom domain + TLS: Lightsail-managed certificate for `app.babylontoolkit.com`.
6. Stripe webhook endpoints registered per env (staging = test mode).
7. CI flow: PR → typecheck/tests; merge to `main` → deploy staging; tagged release → deploy prod. AWS creds as repo secrets (the CI IAM user).
8. Play origin: create CloudFront + OAC over the play bucket once; Share flow (§4.8) writes `dist/` to `s3://btk-play-builds-{env}/{shareId}/` and the page is live.

## Storage integration changes (supersedes Supabase Storage mentions in SPEC §4.5.5/§4.8/§4.11)

> **⚠️ THE PROJECT SNAPSHOT STORE IS DELETED — not narrowed, not dormant (SPEC §4.5.4b; migration 0007, 2026-07-16).** This document was written when the platform snapshotted every project after every generation. **The user's code lives in their own repo, and their in-progress checkpoints live in their browser** (`local-snapshots.ts`, IndexedDB). There is no `snapshots` table, no `SnapshotStore`, and no snapshot route — `POST /api/projects/:id/snapshots` does not refuse, it does not exist.
>
> An earlier revision of this warning said the envelope had "two remaining readers": the remix seed, and a **dormant `ObjectStore` fallback**. The fallback is gone — keeping a project-storing route locked rather than removed is a door, and a `snapshots` table with a live RLS policy is somewhere to write. One reader remains:
>
> - the **remix seed** (§4.8) — deposited when an owner publishes, so strangers can remix a game whose repo is private. It is one object per project at **`seeds/{projectId}.json`** (`share/seed-store.ts`), read-only over `GET /api/projects/:id/seed`, deleted on unpublish.
>
> Everything below about the base64 ENVELOPE and its byte integrity is still exactly right — it is the same `SerializedFileMap` codec, now on the seed path. The BUCKET is unaffected and still carries template pins (§4.4) and skill resources (§4.11) under their own prefixes. **Sizing note: it no longer grows with every generation of every project** — it grows with publishes.

- Remix seeds: a JSON envelope of the project file map (binaries carried as base64 entries alongside their true byte `size`) → `seeds/{projectId}.json`. The key is **derived from the project id** — there is no stored path and no row, so nothing can point at the wrong object, and no caller-supplied id can name someone else's bytes. Server-side access only (runtime IAM role); clients get contents via the app, never S3 URLs. *(base64 is lossless and carries true byte counts, so byte integrity below is unaffected; the format is an implementation detail behind the storage interface.)*
- Shared builds: uploaded by the server after the in-WebContainer `npm run build`, to the play bucket under `{shareId}/`.
- Skill resources (§4.11): stored under `s3://btk-snapshots-{env}/skills/{skill}/{version}/...` (same private bucket, server-read-only path).
- Lifecycle policies: a seed is deleted on unpublish and on project delete (there is nothing to prune on a schedule — one object per published project, overwritten in place on re-publish); play builds persist while `share_id` is active, deleted on unpublish.

## Seed & build transport (how bytes actually move)

**SDK:** `@aws-sdk/client-s3` (AWS SDK for JS v3), used **server-side only** (`app/lib/.server/storage`) with the `btk-app-runtime` credentials. An AWS key appearing in a client bundle is a critical bug (same rule as the Anthropic platform key).

**Upload (publish):** the client posts its source alongside the `dist/` build (binary bytes read via `FilesStore.readBinaryFile()`, never `dirent.content`, which is always empty when `isBinary`) → server verifies session + project ownership → `buildRemixSeed` strips the `.env` family and the generated bulk → `PutObjectCommand` → `seeds/{projectId}.json`, then stamps `projects.remix_seed_at`. Object first, pointer second: a failed write leaves the project honestly reading as "no seed".

> **There is no upload path for an ordinary project, and that absence is the design (§4.5.4b).** The browser cannot ask the platform to store its files; a seed is deposited only by publishing or remixing, both deliberate acts on a game meant to be public.

**Download (a remix's first mount):** server `GetObjectCommand` → streams the envelope to the client → client base64-decodes binaries back to `Uint8Array` and writes them over the freshly mounted template base in the WebContainer, then adopts the result as that browser's first local checkpoint.

**Published builds (share):** server `PutObjectCommand` per file of `dist/` → `s3://btk-play-builds-{env}/{shareId}/` → CloudFront serves it. Objects need correct `ContentType` and, for `.gz.*` assets, `ContentEncoding: gzip` (see the headers policy above).

**Scaling escape hatch — presigned URLs:** proxying every byte through the Lightsail container is simple and safe but makes the app a bandwidth bottleneck for asset-heavy Toolkit projects. When project sizes warrant it, switch to server-issued **presigned S3 URLs**: the server still authorizes (it decides who gets a URL for which key) while the browser transfers directly to/from S3. Build the proxy path first; keep the storage layer behind an interface so this is a swap, not a rewrite.

**BYTE INTEGRITY (required test):** the envelope is built from a `Uint8Array`-faithful file map — binaries base64-encoded from real bytes, never from a UTF-8 string. If any step stringifies content, PNG/GLB/WASM bytes corrupt **silently** — the project looks fine now and returns broken tomorrow. *(Built: hash-identity in `binary-files.spec.ts`; the round-trip against hostile bytes in `seed-store.spec.ts`, ported from the deleted `snapshots.spec.ts` when the store went — **the store was removable, the invariant was not**. The local checkpoint path has its own in `local-snapshots.spec.ts`.)*

**Local development:** with `S3_*` unset, the storage layer uses a local-filesystem adapter (build-first, SPEC §1.3 principle 0 / §9a) — no AWS account needed to develop. Dev AWS keys, when used, live in `.env.local` (gitignored) and point at **separate dev buckets**, never staging/prod.

## Scaling & ops notes

- SSE concurrency is the sizing driver, not CPU (LLM work happens at Anthropic). Start nano/micro; bump power before adding nodes (sticky sessions not required — app is stateless; anything stateful in the container is a bug).
  - 🔴 **That rule was violated for the whole build and nothing was checking it (fixed 2026-08-01, SPEC §8d).** The prompt and skills stores wrote to `.data/` on the container's own disk, so **every deploy would have landed a container that could not generate at all** — there is no boot-time doc-sync, so a version is built only when an admin presses Refresh. Both now persist through `ObjectStore` → S3, and `/healthz` reports `systemPrompt` so the state is visible instead of silent. **A rule that cannot fail is a rule nobody is keeping** — the same lesson as the sandbox seam, which held "in spirit" while 13 modules imported the vendor directly.
  - Local dev is unaffected: `ObjectStore` falls back to the filesystem, so the data simply moved from `.data/prompt` + `.data/skills` to `.data/storage/prompt` + `.data/storage/skills`. The old directories are dead and can be deleted.
- Deploys restart containers: in-flight generations abort → client retry affordance; ledger abort/refund rules (spec/billing.md) cover billing. Deploy during low traffic.
- Cost ballpark at beta scale: Lightsail ~$7–15/mo per env + S3/CloudFront cents-to-dollars + Supabase free tier. Verify current AWS pricing before committing budgets.
- Migration path if outgrown: same image to ECS Fargate + ALB; storage/DB unchanged.

## Domain migration runbook (rebrand support — SPEC §2.5)

If the app domain ever changes (e.g., away from app.babylontoolkit.com):
1. DNS: new record → Lightsail endpoint; issue Lightsail-managed TLS cert for the new domain.
2. Env: update `APP_URL` (and `SHARE_DOMAIN` if the share domain changes); redeploy. All share links, emails, and meta URLs follow automatically (brand-module rule).
3. **The three tentacles (15 min each; forgetting one silently breaks a flow):**
   a. OAuth redirect URLs — Google console, GitHub OAuth app, AND Supabase Auth URL configuration.
   b. Stripe webhook endpoint URLs (per env) — re-register + new signing secrets into SSM.
   c. GitHub doc-sync webhook URL on the agent/skills repos.
4. Permanent 301 from the old domain → new (tiny CloudFront/redirect rule; keep indefinitely).
5. Update `brand.ts` marketing/domain fields; swap `app/assets/brand/` if the visual identity changes too.
