# Spec for unity-project-licenser

branch: project/feature/unity-project-licenser
design_system: DESIGN.md
spec_impact: yes

## Summary

Replace the PayPal/ASMX-era Unity Exporter licensing with a platform-native licenser driven by the user's Stripe credits plan. A user links their Unity project (by Unity Project ID / `productGUID`) to an App Builder project via a new "Link Unity Project" control on the existing Unity Exporter connect surface. The platform then generates (and can re-generate at any time) a `license.json` — byte-compatible with the existing `licenser.cs` validator shipped in the Unity Exporter plugin — whose tier derives from the user's current subscription: signup-grant/Starter → Indie, Pro → SmallBusiness (2 blank editable seats), Studio → PremiumContent (unlimited, unchecked seats). The license is locked to that Unity Project ID, never expires, is written to the web project root as `/license.json`, and is best-effort dropped into the Unity project at `Assets/[Config]/license.json` through the connected Unity MCP bridge. The legacy `licenser.asmx` SOAP client is retired as an authority; Pro features remain disabled (`PRO_FEATURES_ENABLED=false`).

## Project Spec Alignment (from SPEC.md — REQUIRED)

- SPEC.md sections this feature relies on or must conform to:
  - **§4.6 Credits & Billing** — Stripe subscription plans (`sub_starter`/`sub_pro`/`sub_studio`) are the licensing authority; `invoice.paid` remains the only grant path (this feature reads plan state, never writes the ledger).
  - **§4.6.1 Pro Tools Subscriber Entitlements** — currently names `licenser.asmx` as the sole authority; this feature supersedes that.
  - **§4.17 Unity Editor Bridge** — the connect surface, `unity` reserved server name, loopback-only transport, direct `callUnityTool` execution, 180s window, "no file channel" scoping.
  - **§4.5.3 Authorization** — two-wall rule (verified session + `requireOwnedProject`, 404-not-403) for every new route.
  - **§4.5.4b Repo-primary persistence** — the platform stores project metadata only; `linkedUnityProjectId` is metadata (follows the `gameBackendRef` precedent); the license file itself lives in the user's project (WebContainer/repo), not on our servers.
  - **§4.2.8 Context budget** — `license.json` is classified opaque; the new UI/state must not perturb the cached prompt prefix.
  - **§5 Security** — crypto and plan lookup are server-only (`app/lib/.server/**`); no platform secret is emitted; no server-side execution of user code.
- How this feature fits the existing architecture: a new server-side license builder module under `app/lib/.server/licensing/` (pure functions + two-wall routes), a per-project metadata field on the `Project` record (both store backends + migration 0011), a client flow that reuses the existing Unity connect dialog (`UnityConnection.tsx`), the direct Unity tool-call path (`callUnityTool`, no LLM generation, no credits), and the established WebContainer file-write pattern (`workbenchStore.createFile`).
- **spec_impact = yes** → SPEC.md changes:
  - **§4.6.1**: the external license service (`licenser.asmx`) is no longer called; the SOAP client is retired. BYOK/Pro gating remains disabled (`PRO_FEATURES_ENABLED=false` unchanged); if Pro gating is ever re-enabled, its authority will be the Stripe plan (via the tier resolver introduced here), not the ASMX service.
  - **New §4.18 — Unity Project Licenser**: records the tier mapping, license-format compatibility contract with `licenser.cs`, project-locked/never-expires policy, the Link Unity Project flow, and the best-effort MCP drop.
  - **Decisions log**: append the owner decisions (ASMX retirement; PremiumContent reuse for Studio; never-expires project-locked licenses).
- Conflicts with SPEC.md (resolved): §4.6.1's scope-boundary line "project license-key generation belongs to the Unity Editor Export Tool, not this platform" is explicitly superseded by owner direction — the platform now generates project licenses. The SPEC.md write-back must remove/replace that line.

## Functional Requirements

### Link Unity Project
- The existing Unity Exporter connect dialog (`UnityConnection.tsx`, chat prompt toolbar) gains a **Link Unity Project** section: an input for the Unity Project ID (the `PlayerSettings.productGUID` — 32 lowercase hex chars, shown with a short hint on where to find it in the Unity Editor), with Link / Unlink / Re-link actions.
- The linked id is stored per App Builder project as `linkedUnityProjectId` on the `Project` record (server-side, both FS and Supabase backends, migration `0011`), following the `gameBackendRef` pattern. Linking requires the two walls (verified session + `requireOwnedProject`).
- Linking does NOT require the Unity bridge to be connected (the id can be pasted manually); the MCP drop is the only part that needs a live connection.
- Input is validated server-side as a plausible Unity project GUID (32 hex chars; reject empty/whitespace/other shapes with a descriptive error).

### License generation
- A **Generate License** action (same dialog) is available once a Unity Project ID is linked. Re-generation is allowed at any time and always reflects the user's **current** plan.
- Tier mapping (authority = current Stripe subscription via the existing `findActiveSubscription(userId)`; no subscription → Indie):
  - No active subscription (signup-grant users) or `sub_starter` → plan **`Indie`**, seats `s1 = s2 = "locked"`.
  - `sub_pro` → plan **`SmallBusiness`**, seats `s1 = s2 = ""` (blank — the user may hand-edit two seat emails into the file inside their Unity project; seats are outside the encrypted secret and the key hash, so editing them never invalidates the license).
  - `sub_studio` → plan **`PremiumContent`**, seats `s1 = s2 = "unlimited"` (unlimited, not checked).
- License field contract (must validate against the existing `licenser.cs` `ValidateLicenseKey()` unchanged):
  - `licensee` = the authenticated platform user's email (Supabase-verified; never client-supplied).
  - `product` = the linked Unity Project ID (this is the value the plugin hashes against `PlayerSettings.productGUID` — the project lock).
  - `project` = the App Builder project name (display/free text).
  - `org` = optional organization string (blank by default; a small optional input in the dialog).
  - `trial` = `false`; `expires` = `"never"` (owner decision: the license is perpetual for the project it was generated for).
  - `secret` = AES-256-CBC ciphertext (base64) of `plan|licensee|org|product|project|expires` using the same key-derivation and IV as `licenser.asmx`'s `SecurityTools.EncryptString` (byte-exact .NET `PasswordDeriveBytes` replication; validated by test vectors).
  - `key` = `ComputeProjectLicenseKeyHash(plan + "-" + product)` — same MD5/Unicode/28-char/dash-grouped algorithm and private-key constants (`babylontoolkit.com`, `05.00.00`) as the reference implementations.
- Generation and all crypto run **server-side only** (`app/lib/.server/licensing/`); the key phrase/IV/private-key constants never enter a client bundle. Generation is free (no credit debit) and idempotent.
- Generation requires the two walls; the plan lookup is keyed on the server-verified user id (never email, never client input).

### License delivery
- On generation, the client writes the returned JSON to the web project root as **`/license.json`** via the established `workbenchStore.createFile` pattern (string content). The file participates in normal repo-primary persistence (it is the user's own license, meant to travel with their project; it is NOT a secret path).
- **Best-effort Unity drop**: if the Unity bridge is connected, the client additionally writes the license into the Unity project at **`Assets/[Config]/license.json`** via a direct `callUnityTool(...)` call (no LLM generation, no credits) using a dynamically discovered asset/script-write tool from `unityToolsAtom`. If the bridge is disconnected or no suitable tool is found, the flow degrades gracefully: the web-project file is still written and the dialog shows manual copy instructions (source path → destination path). A failed drop is reported loudly in the dialog — never a silent false success.
- `license.json` is classified **opaque** in `app/lib/context/opaque-files.ts` (declared, never shown to the model).

### ASMX retirement
- The SOAP client (`app/lib/.server/licensing/licenser.ts` `validateSubscription`) and the ASMX-driven entitlement refresh are retired — no code path calls `licenser.asmx` anymore. The `entitlements` table and `resolveByok` remain in place but inert (`PRO_FEATURES_ENABLED=false`); nothing new writes entitlements.
- The `LICENSE_SERVICE_URL` / `LICENSE_SERVICE_SECRET` env vars become unused; document them as retired.

### Non-goals (this feature)
- No change to BYOK/Pro gating (stays disabled), the credit ledger, or Stripe webhooks.
- No Enterprise/Partner license generation (the ASMX `GeneratePartnerLicense` admin path is out of scope; owner can revisit later).
- No license revocation/expiry machinery (never-expires is the accepted policy).
- No changes to the Unity Exporter plugin (`licenser.cs`) — compatibility with the shipped validator is a hard constraint.

## Design System Reference

- No `DESIGN.md` design system found — follow the existing UI conventions already in the codebase.
- Concretely: extend the existing `UnityConnection.tsx` dialog (chat prompt-toolbar `IconButton` + `Dialog` pattern, same as `SupabaseConnection.tsx`); reuse its input, button, status-badge, and error-toast styles; keep the connect/pair section visually distinct from the new Link/License section.
- No sibling-skill pattern applies to this feature (no bt-design/bt-hero/etc. deterministic pattern involved).

## Possible Edge Cases

- **Plan downgrade/cancellation**: regeneration after a downgrade produces the lower tier; the previously generated higher-tier license stays valid forever for that Unity project (accepted policy). The dialog should show which tier the next generation will produce.
- **Email mismatch**: the Unity plugin compares `licensee` to the Unity account email (`CloudProjectSettings.userName`). An Indie user whose Unity account email differs from their App Builder email will not pass the seat check; surface this in the dialog copy (SmallBusiness/Studio users can use seats; Indie users must use the same email).
- **Same Unity project linked from multiple App Builder projects / re-linking a different id**: allowed; each generation is locked to whatever id is linked at that moment. Old licenses remain valid (accepted).
- **Stripe not configured / local mode**: `findActiveSubscription` unavailable → degrade to Indie (never throw); local-mode verified user generates Indie licenses.
- **Stripe transiently unreachable**: degrade to Indie with a visible notice and easy re-try — never fabricate a paid tier, never block the dialog.
- **Crypto fidelity**: .NET `PasswordDeriveBytes` (null salt) is a non-standard PBKDF1 extension — the Node implementation must be validated byte-exactly against known-good `secret` values produced by the reference C# (test vectors required; see Testing).
- **Unicode emails/project names**: the secret/hash pipeline must match .NET behavior for non-ASCII input (UTF-8 for the secret payload; UTF-16LE for the hash seed).
- **MCP drop hazards**: tool names are discovered dynamically and differ across unity-mcp versions; the `[Config]` folder may not exist yet (create it); `unity` remains the reserved server name; a partial write or tool error must surface as a failure with manual instructions, not success.
- **`license.json` overwrite**: regeneration overwrites the existing root `/license.json`; the Unity-side drop overwrites `Assets/[Config]/license.json`. Both are intended (re-generate is a feature); no versioning.
- **Unlinking** clears `linkedUnityProjectId` but never deletes already-generated license files (they are the user's).

## Acceptance Criteria

- A verified user with a linked Unity Project ID can generate `license.json` from the Unity connect dialog; the file appears at the web project root.
- A generated Indie license (signup-grant user) validates in the Unity Editor via the unchanged `licenser.cs`: `IsPro()` true, key hash matches that project's `productGUID`, seats locked to the licensee email.
- A `sub_pro` user's license carries plan `SmallBusiness` with `s1`/`s2` blank; hand-editing two emails into the file in Unity grants those seats without invalidating the license.
- A `sub_studio` user's license carries plan `PremiumContent` with unlimited seats.
- A license generated for Unity project A does not validate in Unity project B (key hash mismatch).
- Generation reflects the current plan on every regeneration; no credits are debited.
- With the Unity bridge connected, the license is also written to `Assets/[Config]/license.json` in the Unity project; with the bridge disconnected, the flow completes with manual instructions and no error noise.
- All new routes enforce the two walls (someone else's project id → 404); the crypto constants appear in no client bundle.
- No code path calls `licenser.asmx`; `pnpm typecheck && pnpm lint && pnpm test` stay green.
- `license.json` never appears in model context (opaque classification test).

## Open Questions

- **Test vectors**: owner to supply 1–2 known-good license.json files (or plaintext→secret pairs) produced by the live `licenser.asmx` so the Node crypto can be pinned byte-exactly. (Fallback: generate vectors from the reference C# locally.) -> @license.json is an actual live licence file
- Should the dialog offer a **Download license.json** button in addition to the root-file write? (Cheap add; default: yes if trivial.) -> Yes
- Should `org` ever be validated against anything (the plugin compares it to `CloudProjectSettings.organizationName` only for `IsOrganization()`), or stay free-text? (Default: free-text, blank.) -> Use `*` for any org
- Future: when Pro features are re-enabled, should `resolveByok` read the Stripe plan via this feature's tier resolver? (Out of scope now; noted for §4.6.1's future.) -> that will be a manual thing from here forward and for testing only. We are now all credits based businss, like lovable and bolt, but dedicated to the specialized Unity Style high quality game development framework

## Testing Guidelines

Create test files under the module they exercise (repo convention: specs beside code, e.g. `app/lib/.server/licensing/unity-license.spec.ts`) — never under `app/routes/`:
- **Crypto compatibility**: `EncryptString`-equivalent output matches known-good C# vectors (byte-exact base64); round-trip decrypt matches the pipe-delimited payload; `ComputeProjectLicenseKeyHash` matches reference outputs for known seeds (including the 28-char/dash-group formatting and case rules).
- **Tier mapping** (pure function): no-sub → Indie; `sub_starter` → Indie; `sub_pro` → SmallBusiness with blank seats; `sub_studio` → PremiumContent unlimited; unknown plan id → Indie (never throw); Stripe error → Indie + notice.
- **License assembly**: field contract (licensee=verified email, product=linked GUID, trial=false, expires="never"), GUID validation (reject non-32-hex).
- **Routes**: two-wall enforcement (unauthenticated → 401; someone else's project → 404); link/unlink round-trip through both project-store backends; migration 0011 pinned in the PGlite harness.
- **Context budget**: `license.json` classified opaque in `opaque-files.spec.ts`.
- **Client flow** (unit-level): generation writes `/license.json` via `workbenchStore.createFile`; MCP drop is attempted only when `unityConnectionAtom` is connected; drop failure surfaces an error state (no false success).
