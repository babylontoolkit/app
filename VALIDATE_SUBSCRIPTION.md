# VALIDATE_SUBSCRIPTION.md — the Unity Editor subscription check

Practical guide for the operator and for whoever writes the Unity side. The design and its reasoning
live in [SPEC.md](SPEC.md) §4.18a; this is the "what do I actually type" file.

**What it answers:** *does the developer with this email address have a live entitlement to the Unity
Pro Tools?* One boolean, plus a short reason. It does not return a tier, an expiry, or anything else.

---

## TL;DR

```bash
POST /api/unity/subscription
Authorization: Bearer <UNITY_SUBSCRIPTION_API_KEY>
Content-Type: application/json

{"email":"dev@studio.com"}

200 {"email":"dev@studio.com","hasActiveSubscription":true,"reason":"credits"}
```

`GET /api/unity/subscription?email=<address>` works identically and is still supported.

Local setup is one line:

```bash
echo "UNITY_SUBSCRIPTION_API_KEY=$(openssl rand -hex 32)" >> .env.local
# restart pnpm dev — the key is read at boot
```

Production needs **two** things, and skipping the second fails quietly. See [Setup](#setup).

---

## What counts as "active"

An **active Stripe subscription OR a credit balance greater than zero.** Either grants access, and
`reason` tells you which did:

| `reason` | Meaning |
|---|---|
| `subscription` | A live Stripe plan — status `active`, `trialing`, or `past_due` |
| `credits` | No live plan, but a credit balance `> 0` |
| `none` | Neither — **or we have never seen this email at all** |

This follows SPEC §4.18: *the credit balance IS the Pro Tools entitlement*. Someone who bought a
one-off credit pack has paid us money and expects the Editor tools to work, so gating on the
subscription alone would lock out exactly those customers, silently, with no way for them to tell why.

Three details that are easy to get wrong if you reimplement this logic anywhere else:

- **`past_due` counts.** That is Stripe's dunning window — a customer whose card failed, not a
  customer who left, and Stripe is retrying the charge at that moment. `canceled`, `unpaid`,
  `incomplete`, `incomplete_expired` and `paused` do not count.
- **`cancel_at_period_end` is not a status.** Stripe keeps such a subscription `active` until the
  period actually ends. They paid for the month; they get the month.
- **The balance test is `> 0`, never `>= 0` or `!= 0`.** A generation debit may legitimately drive a
  balance negative (SPEC §4.2.1), so `!= 0` would grant access to an overdrawn account, and `>= 0`
  would grant it to every signed-up stranger who has never bought anything.

---

## The contract

### Request

Two forms, one handler. **POST is preferred** — the email travels in the body, so it stays out of
access logs, proxy logs and browser history:

```
POST /api/unity/subscription
Content-Type: application/json

{"email":"dev@studio.com"}
```

```
GET /api/unity/subscription?email=<url-encoded address>
```

GET is kept working because it is what shipped and an Editor already in the field must not break. The
method was never the security axis: both go through the same authentication, the same rate limit and
the same answer, in that order. The only difference is where the address ends up.

A POST body that is not JSON, or that has no string `email`, gets the same `400` as a missing address
— never a `500`, which would read to the Editor as "the platform is down".

The key goes in a **header**, one of these two — never in the query string, which is refused on
purpose (a credential in a URL lands in access logs, proxy logs and browser history):

```
Authorization: Bearer <key>
X-Api-Key: <key>
```

The email is normalised server-side: trimmed and lowercased, so `  DEV@Studio.com ` and
`dev@studio.com` are the same request. Single-label domains (`dev@localhost`) are accepted.

### Responses

| Status | Body | What to do |
|---|---|---|
| `200` | `{"email":…,"hasActiveSubscription":true\|false,"reason":…}` | Trust it |
| `400` | `{"error":true,"message":"A valid \"email\" is required…"}` | Fix the address (or the JSON body) |
| `401` | `{"error":true,"message":"A valid API key is required."}` | Missing or wrong key |
| `429` | `{"error":true,…}` + `Retry-After: <seconds>` | Back off for that many seconds |
| `503` | `{"error":true,"message":"The Unity subscription API is not configured…"}` | Server has no key set |
| `5xx` | generic message | We could not answer — see [failure handling](#failure-handling) |

Every `200` carries `Cache-Control: no-store`, so no proxy holds an entitlement answer past the moment
a subscription lapses.

### One deliberate non-feature

**An unknown email and a known email with nothing return byte-identical bodies** —
`{"hasActiveSubscription":false,"reason":"none"}`. There is no way to learn whether an address has an
account. That is intentional: see [Security model](#security-model).

---

## Unity client

Drop-in, works in Editor code. Uses `UnityWebRequest` and `JsonUtility`, no dependencies.

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public static class BabylonToolkitSubscription
{
    const string Endpoint = "https://app.babylontoolkit.com/api/unity/subscription";

    // Ship this in your package. It is NOT a secret — see the docs. Rotate by shipping a new build.
    const string ApiKey = "PASTE_YOUR_KEY_HERE";

    [Serializable]
    class Response
    {
        public string email;
        public bool hasActiveSubscription;
        public string reason;
    }

    /// <summary>
    /// Calls back with (isActive, reason). `reason` is "subscription", "credits", "none",
    /// or "error:<detail>" when the question could not be answered.
    /// </summary>
    public static IEnumerator Check(string email, Action<bool, string> done)
    {
        /*
         * POST: the address travels in the body, so it never lands in an access or proxy log.
         *
         * For the GET form, replace the three lines building `body` and the `using` header with:
         *
         *     var url = Endpoint + "?email=" + UnityWebRequest.EscapeURL(email);
         *     using (var request = UnityWebRequest.Get(url))
         *
         * and drop the uploadHandler/downloadHandler/Content-Type lines. Everything below is identical
         * — same key header, same status handling, same response shape.
         */
        var body = Encoding.UTF8.GetBytes("{\"email\":\"" + email.Replace("\"", "\\\"") + "\"}");

        using (var request = new UnityWebRequest(Endpoint, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(body);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", "Bearer " + ApiKey);
            request.timeout = 15;

            yield return request.SendWebRequest();

            // 429: the server tells you exactly how long to wait. Honour it rather than retrying blind.
            if (request.responseCode == 429)
            {
                var after = request.GetResponseHeader("Retry-After");
                done(false, "error:rate-limited retry after " + (after ?? "60") + "s");
                yield break;
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                // 401 = bad key, 503 = server not configured, 5xx/network = unknown.
                done(false, "error:" + request.responseCode + " " + request.error);
                yield break;
            }

            Response parsed = null;

            try { parsed = JsonUtility.FromJson<Response>(request.downloadHandler.text); }
            catch (Exception e) { done(false, "error:unparseable " + e.Message); yield break; }

            if (parsed == null) { done(false, "error:empty response"); yield break; }

            done(parsed.hasActiveSubscription, parsed.reason);
        }
    }
}
```

Call it from an `EditorCoroutine`, or from any MonoBehaviour with `StartCoroutine`:

```csharp
StartCoroutine(BabylonToolkitSubscription.Check(userEmail, (active, reason) =>
{
    Debug.Log($"Pro Tools: {(active ? "enabled" : "disabled")} ({reason})");
}));
```

### Client rules that matter

- **Cache the answer; do not call it per frame, per compile, or per inspector redraw.** The limit is
  60 requests per minute per caller. Check once on Editor load, and again on an explicit "refresh
  licence" button.
- **Distinguish `false` from "could not ask".** A `200` with `false` is a real answer — this developer
  has not paid. A `5xx`, a timeout or a captive-portal redirect is *not* an answer, and treating the
  two the same is how you lock a paying customer out of their tools because their hotel wifi hiccuped.
- **Never parse the `reason` string to unlock different features.** It is for humans and support. The
  only thing that gates anything is `hasActiveSubscription`.

### Failure handling

Deliberately your call, but the recommended shape:

| Situation | Suggested behaviour |
|---|---|
| `200 false` | Lock the tools. This is a real "no". |
| `401` / `503` | Lock, and surface "licence server not reachable — contact support". These mean *our* config is wrong; a developer cannot fix them and should not be blamed. |
| `429` | Keep the previous answer, retry after `Retry-After`. |
| `5xx` / network / timeout | Keep the last known-good answer, cached with a timestamp. Consider a grace window (say 7 days) before locking, so an outage on our side never bricks a paying customer's Editor. |

The endpoint deliberately **does not** degrade a failure to `false` for you. It returns an error so
you can tell the difference. Answering `false` on an outage would deny paying customers silently,
which is the failure mode this codebase treats as worst-of-all (`spec/fail-loud.md`).

---

## Setup

### Local development

```bash
echo "UNITY_SUBSCRIPTION_API_KEY=$(openssl rand -hex 32)" >> .env.local
```

Restart `pnpm dev` — the key is read at boot, so a running server will not pick it up. **No database
migration is needed locally:** with Supabase unconfigured the app runs in local mode with a single
user (`local@localhost`), and that is the only address that will resolve.

```bash
curl -H "Authorization: Bearer <key>" \
  "http://localhost:5173/api/unity/subscription?email=local@localhost"
# → {"email":"local@localhost","hasActiveSubscription":true,"reason":"credits"}
```

### Production — both steps required

**1. The key.**

```bash
aws ssm put-parameter --name /btk/prod/UNITY_SUBSCRIPTION_API_KEY \
  --type SecureString --value "$(openssl rand -hex 32)"
```

Then redeploy so the container picks it up ([DEPLOY.md](DEPLOY.md) §1.4). Read the value back with
`aws ssm get-parameter --name /btk/prod/UNITY_SUBSCRIPTION_API_KEY --with-decryption` — that string is
what goes into the Unity package.

**2. 🔴 The migration — and this is the one that fails quietly.**

Apply [`supabase/migrations/0022_user_id_for_email.sql`](supabase/migrations/0022_user_id_for_email.sql)
(Supabase dashboard → SQL Editor → paste → Run, or however you have applied 0001–0021). It creates the
function that turns an email into a platform user id.

**Without it the endpoint still returns `200`, and it returns `false` for everybody** — because the
lookup that resolves the email does not exist. That reads as "nobody on the platform is subscribed"
rather than as an error, so verify it with a real account after deploying rather than assuming.

Sanity check straight after applying:

```sql
select public.user_id_for_email('a-real-user@example.com');  -- expect a uuid, not null
```

### Optional tuning

| Variable | Default | Notes |
|---|---|---|
| `UNITY_SUBSCRIPTION_API_KEY` | *(unset)* | **Unset = the endpoint 503s everyone.** Never means "no key required". |
| `UNITY_SUBSCRIPTION_RATE_MAX` | `60` | Requests per window, per caller |
| `UNITY_SUBSCRIPTION_RATE_WINDOW_MS` | `60000` | Window length |

---

## Security model

Read this before changing anything here.

**The API key is not a secret.** It ships inside a Unity package that is distributed to developers, so
anyone who downloads the tools can extract it. It is a **throttle and a rotation handle**: it stops the
endpoint being trivially scriptable by someone who has never seen our Editor tools, and it lets us
invalidate a leaked key by shipping a new build. It is not a wall against a determined attacker.

Everything else follows from that honest starting point:

- **The rate limit is part of the wall, not a nicety.** Without it, whoever extracts the key could walk
  a list of addresses and learn which of them are our paying customers.
- **Unknown and inactive are indistinguishable.** Otherwise the endpoint is an account-existence oracle
  on top of a subscription one. Same reasoning as `requireOwnedProject` answering 404 rather than 403.
- **It fails closed.** No key configured → 503 for everyone. The inverse — "no key means no check
  required" — is how an internal tool becomes a public customer list during a deploy that drops one
  variable, with nothing throwing.
- **The database function is service-role only.** `public.user_id_for_email` is `security definer` over
  `auth.users`, and Postgres grants EXECUTE to PUBLIC by default. It is revoked from
  `public`/`anon`/`authenticated`. Left alone, any signed-in user could turn any address into an
  internal user id through the browser's own Supabase client. This is asserted against a real Postgres
  in `user-id-for-email-sql.spec.ts`.

**If this ever needs to be stronger:** issue a per-developer token from the account page and have the
endpoint report only the caller's own status. That drops the `email` parameter entirely and removes
the enumeration surface. The route is written so this becomes a second accepted credential rather than
a rewrite.

### Rotating the key

1. `aws ssm put-parameter --overwrite --name /btk/prod/UNITY_SUBSCRIPTION_API_KEY --type SecureString --value "$(openssl rand -hex 32)"`
2. Redeploy.
3. Ship a Unity package carrying the new key.

Note the ordering cost: between steps 2 and 3, Editors on the old package get `401`. If that matters,
add a second accepted key temporarily rather than swapping in place.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `503` on every request | `UNITY_SUBSCRIPTION_API_KEY` is not set on the server. Working as designed. |
| `401` with a key you believe is right | Check for a trailing newline or quotes in the SSM value; check `Bearer ` has exactly one space; confirm the key is in a **header**, not the URL. |
| `400` on a valid-looking address | Must contain exactly one `@`, no whitespace, and be 3–254 characters. |
| **`false` for everyone, including known subscribers** | **Migration 0022 has not been applied.** The most likely cause, and the quietest. |
| `false` for a subscriber who definitely pays | Stripe Search is eventually consistent (~a minute for a brand-new subscription). Also confirm the subscription carries `metadata.userId` — set at checkout; subscriptions created by hand in the Stripe dashboard will not have it and cannot be matched. |
| `true` for someone with no plan | Expected if they hold credits. Check `reason` — `credits` is a valid entitlement here. |
| `429` in normal use | The client is calling too often. Cache the answer; see the client rules above. |

### Reading the server's view

```bash
pnpm credits            # the local ledger + balance, to confirm what the credits branch sees
```

For a deployed environment, the Admin tab's usage report is the equivalent.

---

## Related

- [SPEC.md](SPEC.md) §4.18a — the design, and why open question #12 was reopened
- [CREDITS.md](CREDITS.md) — the credit system this endpoint reads
- [DEPLOY.md](DEPLOY.md) §1.4 — SSM parameters
