# Auto-pilot run log — unity-bridge-local-gltf

## Run 1 — started 2026-09-29 15:46 · branch btk-sandbox · command: --auto-pilot ALL

Decisions:
- Commit on current branch `btk-sandbox` (not the default branch); the plan's named feature branch is not checked out and switching would carry no benefit.
- Independent streams run concurrently to save wall-clock (owner: "TIME MATTERS"): app-repo phases (sequential among themselves), exporter C# (Phase 3), Agent Reference docs (Phase 4). Each phase still gets its own implementer + independent verifier, ticked only on PASS.
- AgentReference working tree was clean at start (the plan expected `unity-exporter-cli.md` uncommitted — the owner has since committed it); T13 keeps the anonymised examples either way.

Tasks:
- Baseline (app, pre-change): 364 test files, 8004 passed, 2 skipped, 0 failed.
- T10 ⏭️ DEFERRED — permission classifier denied editing `PE/Core/System/BabylonLicense.cs` ("Security Weaken"). Not routed around. Human: approve or hand-apply the three edits in T10 steps 1–4 (only one `CANVAS_TOOLS_OWNERS.IndexOf` use exists, line ~460; the `password24` line ~467), then build + the eval.
- T8 ✅ verified (independent) · 1 attempt · dotnet build 0 errors; curl: single ACAO, CORP, model/gltf+json, OPTIONS 204 + PNA, traversal never 200 (Mono normalises dot segments → 404; ResolveInsideRoot 403 proven for double-encoded/NUL), Range 206 intact · files: WebTools.cs, CanvasToolsInformation.cs, CVPanel.cs, UnityTools_HX.cs (exporter repo, uncommitted per D33)
- T9 ✅ verified (independent) · 1 attempt · already-running keeps port; FirstFreePort → 8889 while 8888 held; dirty-scene guard refused + marker survived; LAN on/off/on · file: BabylonToolkitCliCommands.cs (uncommitted per D33)
- Decision (T9): FirstFreePort made public and reimplemented (connect-probe + bind on IPAddress.Any) — the plan's loopback-bind version returned 8888 while held (SO_REUSEADDR on macOS).
- Owner attention (not caused by this run): `Assets/[Config]/settings.json` BuildWebProject true→false comes from ExportLevel's geometry-only path saving the temporary value to disk (CVTools.cs:178); heals when the Toolkit panel is drawn.
- Plan slip: T8 acceptance "LAN IP refused" contradicts D28 default ON (checked in T9's toggle instead); D29 "real bound port" vs verbatim code reporting the settings port.
- T12 ✅ verified (independent) · 1 attempt · all acceptance greps; 14 steps landed · AgentReference (uncommitted per D33)
- T13 ✅ verified (independent) · 1 attempt · exporter doc 116127 bytes (<120000 after the §14 + §15-symptom-table fallback moves); scripts byte-identical before block deletion; bash -n OK; anonymised examples preserved · AgentReference (uncommitted per D33)
- Decision (T11): §5 temp_override also passes `object=obj` — the plan's form returned CANCELLED on modifier_apply with another object active (verifier reproduced).
- Decision (T13): eval-probe loops use `--result-only` + READY match (the old `| grep -q true` also matched the envelope's success:true).
- T11 ✗ verifier FAIL (attempt 1): §9 quick-reference still carries the broken parent_set-only re-paint recipe → fix sent back to the implementer.
- T14 ✅ verified (independent) · 1 attempt · 33 named cases · app/lib/bridge/*
- T15 ✅ verified (independent) · 1 attempt · migration identical to the plan; ledger reason in step across SQL/TS/specs; PGlite cases pass
- T16 ✅ verified (independent) · 1 attempt · pairing/auth specs; live start returns XXXX-XXXX
- Decision (T14): priceClassOf checks `job` before `script` (the plan's own blender-600 → 4 test requires it).
- Decision (T17): devices revoke also runs settleDropped(dropDevice()) — D13 lists revoke as a refund cause.
- T17 ✗ verifier FAIL (attempt 1): poll-route persistence throttle compares JSON.stringify of stored vs incoming hello — jsonb reorders keys, so production would write bridge_devices on every poll. Fix sent back.
- T11 ✅ verified (fresh verifier, attempt 2) · reweight.py live on Knight (9 meshes, bounds-shift 0, exit 0; .obj → exit 1); §9 quick-ref recipe replaced and run live (max shift 3.6e-15) · AgentReference (uncommitted per D33). Leftover for the owner: a few non-re-paint bpy.ops examples (import/export/select_all) still don't assert FINISHED.
- Phase 4 complete.
- T17 ✅ verified (fresh verifier, attempt 2) · persist-hello canonical compare (6 tests) + isUnsafePath drive rule tightened (`t:Texture` allowed) · live poll 401 without token
- Phase 5 complete → commit dd0a5081.
- T27 ✅ verified (independent) · 1 attempt · grant.spec 19/19; live grant 200 (12 h), unadvertised 403, 'xyz' 400; C# public constants proven to match the private key · BRIDGE_GRANT_PRIVATE_KEY in .env.local only (gitignored). Public constants: scratchpad automation-public-key.txt (also in T28's C#).
- T23 implemented (verification pending) — the live helper paired and polled; UI approval deferred to Phase 7.
- Environment blocker found (Phase 1 verifier): the pinned AppTemplate snapshot (3efa7061…) depends on `@babylonjs-toolkit/next@9.28.0`, which is not on npm (latest 9.25.1) → every NEW project fails `npm install`. T2's "a normal project preview still loads" could not be observed on a fresh project.
- Decision (env blocker): live preview checks use a throwaway test project whose package.json `@babylonjs-toolkit/next` is edited to `9.25.1` inside the builder; the pinned template is NOT changed (owner step: publish 9.28.0 or roll the pin back).
- Decision: T28 proceeds although T10 (a listed dependency) is deferred — T28 uses nothing T10 adds.
- T1 ✅ verified (independent) · fork sw test 10/10; fork suite 1161 pass / 4 pre-existing nodepod-sab failures · Nodepod fork (uncommitted per D33)
- T3 ✅ verified (independent) · 3 `allow` edits, wrapper untouched, opaque .gltf (55/55)
- T4 ✅ verified (independent) · share.spec 73/73. Note: warning may false-positive if a starter README mentions http://localhost:5173/ — check at T25 publish step.
- T2 static/tests PASS (patched sw byte-identical to fork, lockfile minimal, SW v15 live as controller); live "preview still loads" pending the 9.25.1 workaround.
- T28 ✅ verified (independent) · 1 attempt · dotnet build 0 errors; live: malformed/tampered/wrong-project/expired refused, valid 1 h grant → on, parameterless overload a compile error, step-4 reset proven by reflection (wildcard licence dropped after DisableAutomation); automation left OFF · exporter repo (uncommitted per D33). Orchestrator restored one space the edit dropped in BabylonLicense.cs (`string lfile = Path.Combine`).
- Decision (T28): the grant's project check compares against `AutomationProjectGuid()` (each ToByteArray() byte low-nibble-first = the text in ProjectSettings.asset), NOT `PlayerSettings.productGUID.ToString("N")` as the plan's Design Reference wrote — those differ (f435f3e6… vs 6e3f534f…) and the plan's form refused every valid grant. Discovery (T24) reads the .asset text, so all three sides agree.
- Phase 5b complete.
- T23 verified (independent, unit + live helper pairing, mutation-checked) — tick waits for its UI half (approve in the T21 dialog, cube icon shows the device) in the Phase 7 live session.
- T7 ✅ verified (independent) · recovery-copy notice + GitHub 100 MB all-or-nothing refusal; persistence+git 1317 tests pass
- T5 ✗ verifier FAIL (attempt 1): `app/lib/preview/install.ts` watchForErrors turns the new `resource`/`network` entries into a preview actionAlert → paid auto-repair could fire for a stopped local dev server (plan's file list missed install.ts). Explainer itself verified live (dialog once).
- T6 ✗ verifier FAIL (attempt 1): scene URL basename decoded after splitting (`..%2F..%2Fsrc%2Fapp.tsx`) escapes public/scenes/<name>/.
- Phase 6 implemented (T18–T20; prompt refreshed live, 5 new on-demand ids) — verification pending.
- T18 ✅ verified (independent) · service.spec 17 (incl. the D13 cancel+timeout race → exactly one `bridge:<id>` refund), billing.spec 6, PGlite second-refund refusal
- T19 ✅ verified (independent) · 9 bridge tools + import_local_scene; bridge tools only on 'all' toolset when online; bridgeLink from the project row
- T20 ✅ verified (independent) · identity section verbatim; 5 on-demand docs live in the active prompt pv_20260930021930_93fb3836; notes after the last breakpoint (cache-breakpoints.spec unchanged)
- Decision (T18): per-job in-process lock around row writes / onEvent / settleNotStarted (local FsLedger has no unique index; D5 = one instance).
- Follow-ups taken after PASS: tool enum params → z.string() validated in execute (D17 over the plan's z.enum), and isSingleRefundNote widened to `bridge:` so the local ledger mirrors migration 0025.
- T24/T25-code ✗ verifier FAIL (attempt 1): unvalidated server-supplied `jobId` flows into `.bridge/...` paths + recursive rm (scratch probe deleted `Assets/`). Fix sent back, together with a reserved-param-key rule (`--yes`/suffix-override injection) added to BOTH policy copies (D3 parity). Policy parity otherwise verified line-for-line; executors verified live (editor status, capture PNG, Blender output check).
- T5 ✅ verified (fresh verifier, attempt 2) · explainer dialog shown once live; install.ts no longer turns resource/network entries into a paid preview alert (mutation-checked)
- T6 ✅ verified (fresh verifier, attempt 2) · adversarial scene/URI set all contained under public/scenes/<name>/. Orchestrator follow-up: URIs with a scheme but no `://` (`https:evil.com/x`, `file:x`, `C:\x`) now skipped as absolute (+1 spec).
- Phase 2 complete.
- T24/T25-code fix in progress; Phase 7 implemented → live verifier running (also covers T23's UI half and T2's preview check).
- T24/T25-code ✅ fixes verified (fresh verifier, attempt 2): unsafe jobIds dropped before any path is built (probe: Assets survives); unity.command params placed after `--` (live: `-- --yes true` is an unknown PARAMETER, CLI stays JSON) + RESERVED_PARAM_KEYS in both policy copies. helper npm test 115/115. Ticks for T24/T25 wait on the agent-driven live runs in the end-to-end session.
- Commits: c0c3e1b5 (T1–T7), 0dc2fc15 (T18–T20 + validate reserved keys).
- T26 drafted (SPEC §3/§4.4c/§4.5.4d/§4.6/§4.8/§4.17/§4.18a/§5/§8/§10, CLAUDE.md, spec/billing.md, spec/sandbox-nodepod.md + sweep fixes in spec/fail-loud.md, spec/hosting.md) — verification after the end-to-end run.
- Note for the owner: `pnpm.patchedDependencies` in package.json is honoured by the pinned pnpm 9.14.4 (lockfile carries patch_hash) but a global pnpm ≥10 warns it is ignored — move it to pnpm-workspace.yaml when pnpm is upgraded, or the SW fix silently disappears on install.
- T21 ✅ verified (independent, live) · icon left of MCP; Connect dialog with Local scenes first + `--server http://localhost:5173` command; pairing via the dialog; link → green icon
- T23 ✅ verified (UI half live in the Phase 7 session: code approved in the dialog, device listed online)
- T22: unit + live PASS for Status panel (versions, scripts toggle persists), Local-scene import (sha256-identical to the dev server), Jobs panel; Allow/Deny round trip + jobs updating mid-export need a model turn → tick waits for the T25 end-to-end session.
- T2 live ✗ blocked: in a fresh project (next@9.25.1 workaround) `npm run dev` fails in the sandbox — "[offload] WorkerPool is broken — Worker construction failed" → vite.config load error. Running an old-SW vs new-SW A/B to rule T2 in/out.
- Slips (T21): "Blender Blender 5.1.2 found" doubled word; new device appears only on the next 20 s poll after Approve.
- T2 A/B: old (v14) and new (v15) service workers fail `npm run dev` identically → T2 exonerated. Root cause: AppTemplate (3efa706, pushed by the owner 01:28Z today; earlier commits share the deps) has no lockfile, pins `@rolldown/binding-wasm32-wasi@1.2.5` exactly while `vite ^8.0.10` floats to 8.3.1 → rolldown 1.2.11 drives a 1.2.5 wasm binding (`sourcemapPathTransform … expected string`). Installing binding 1.2.11 → vite starts. Owner fix belongs in babylontoolkit/AppTemplate (pin vite or keep the binding in step; ship a lockfile) + publish next@9.28.0.
- The local template pin (3efa706, pinnedBy auto, 01:56Z) was created by this run's first test-project creation; no pin existed before, so there is nothing to roll back to.
- Next: preview still 503s ("No server on <pod>/5173") once vite 8 is up — debug agent getting one test project previewing before the T25 end-to-end run.
- Orchestrator fix: helper reported Blender's version as the whole `--version` line ("Blender 5.1.2"), doubling "Blender" in the Connect dialog and the model note → now the number; doctor still prints "Blender 5.1.2". helper npm test 115/115.
- Commit 506226bb (T21–T22 UI).
- Full app gate after Phases 1–7: typecheck clean, lint 0 errors, 390 files / 8267 tests passed, 0 failed (baseline 364 / 8004).
- T2 ✅ verified live (attempt 2): preview of test project prj_20260930023346_ccibxddg renders the starter Home through the v15 SW (22 resources, 0 ≥400) once vite actually listens.
- Preview recipe (env workaround, test projects only): `@babylonjs-toolkit/next` → 9.25.1 and `dev: "vite --configLoader runner"`. Root cause of the 503: vite 8's rolldown-wasm config bundler throws `sourcemapPathTransform … expected string` under Nodepod (emnapi callback path; suspected, not proven), so vite never listens. Nodepod port registry is fine. Owner items: publish next@9.28.0; in AppTemplate use `--configLoader runner` (or fix the emnapi path in the fork); ship a lockfile. Separate Nodepod anomaly noted: installer's view of node_modules diverged from sb.fs within one pod; `npm install name@ver` doesn't save an already-pinned name.

### Owner correction mid-run (2026-09-29 ~17:15)
- Owner: no per-command credits — bill the AI turn like any generation. Recorded as D53 in the plan. The T25 end-to-end session was stopped (it was about to test per-command charges); its helper process was stopped.
- Rework: remove per-operation bridge billing (ledger reason, 0025 CHECK/index/credits column, billing.ts, BRIDGE_*_CREDITS, credits in jobs/events/UI/tool text/docs). T15/T18/T19/T21/T22/T26 ticks stay (their non-billing acceptance stands) but the rework is independently verified before the end-to-end run.
- Owner correction 2: no project linking / scene browsing — "open or create a Unity project, edit a scene, export it, consume via dev server URL". Recorded as D54 (projects folder on the helper, `unity_project` list/open/create tool, per-device Allow scripts, protocol v2, 0025 edited in place, slimmer UI). Rework starts after the billing removal lands (same files).
