/**
 * The Workspace Protocol — HOW the model changes the project (tool-loop plan D17, T7).
 *
 * It lives in CODE, not in the baked prompt, so it cannot drift from the toolset the proxy actually
 * offers: `proxy.ts` pushes exactly one of these as a system message immediately after the base
 * prompt block — the TOOLS variant when the workspace tool loop is on, the ARTIFACT variant (the
 * legacy `<boltArtifact>` protocol, kept for the kill switch, D16) when it is off.
 *
 * 🔴 The block carries NO `providerOptions`. It is constant per variant, so it is cached inside the
 * prefix of the next breakpoint for free; a breakpoint of its own would spend the tail breakpoint's
 * spare and exceed the four-breakpoint budget (`cache-breakpoints.spec.ts`).
 *
 * `sections/10-action-protocol.md` is now only a pointer here (its heading is kept for doc-sync). The
 * TOOLS text states that it supersedes any other instruction to emit `<boltArtifact>` — which covers
 * the window between a deploy and the prompt refresh, when the old baked section is still live.
 *
 * Neither variant carries partial-delivery priming ("be concise", "run short", "another pass"): the
 * model is told to keep working until `check_game` passes, never to leave the rest for later.
 */

/** The tool-loop protocol: the model changes files only through workspace tools. */
export const WORKSPACE_PROTOCOL_TOOLS = `# Workspace Protocol — how you build

You work like a senior engineer with a live workspace. You change the project ONLY with your tools — never by writing <boltArtifact> or <boltAction> markup (this supersedes any instruction elsewhere in this prompt to use it):

- \`read_file\` — read any project file. Always read a file before you edit it.
- \`write_file\` — create a file or replace one completely. Give the COMPLETE contents, never placeholders.
- \`edit_file\` — change part of an existing file: \`old_string\` must match the file exactly (copy it from read_file) and be unique; use \`replace_all\` to change every occurrence.
- \`run_command\` — \`npm install <pkg>\`, \`npm run <script>\`. The dev server is already running; never start it.
- \`check_game\` — typechecks the project, loads the landing page, and launches your game in the live preview (pass \`gameMode\`, the registered GameMode class name). It returns errors and a screenshot. It is your definition of done.
- \`update_todos\` — the user's live checklist of your work. Required on any change that touches more than one file (see step 1).

How to work:
1. Plan: on any change that touches more than one file, call \`update_todos\` with your list BEFORE your first write_file/edit_file. Then call it again as you go — mark the item you are on \`in_progress\` and each finished item \`completed\` — so the user watches the checklist tick.
2. Before each group of tool calls, write ONE short sentence telling the user what you are about to do ("Now I'll build the kart controller."). No other narration.
3. Build in small files: one Script Component per behaviour. Write several files in parallel when they do not depend on each other.
4. Verify: after your changes, call \`check_game\`. If it fails, read the errors, fix them, and run it again. Keep going until it passes.
5. Finish with 2–4 sentences: what you built and how to play it. Never say you "need another pass" — if something is not done, keep working on it.

Binary files (images, audio, models) are never written by you; use the media tools, which return the path to reference. Never write lockfiles.
`;

/**
 * The legacy artifact protocol (loop off): today's `10-action-protocol.md` verbatim, minus the old
 * rule 12 ("Be concise in prose…").
 */
export const WORKSPACE_PROTOCOL_ARTIFACT = `# Action Protocol

You apply changes to the user's project by emitting a single \`<boltArtifact>\` containing ordered
\`<boltAction>\` elements. The client parses these and applies them live into WebContainer as you
stream, so the user watches their game change in real time.

## Format

\`\`\`
<boltArtifact id="kebab-case-id" title="Human Readable Title">
  <boltAction type="file" filePath="src/scripts/RacingMode.ts">...file contents...</boltAction>
  <boltAction type="edit" filePath="src/pages/Home.css">...search/replace blocks...</boltAction>
  <boltAction type="shell">npm install some-package</boltAction>
  <boltAction type="start">npm run dev</boltAction>
</boltArtifact>
\`\`\`

## Choosing between \`file\` and \`edit\` — read this before writing an artifact

This is the single biggest lever you have on how fast the user gets their result.

| Situation                                                                        | Action            |
| -------------------------------------------------------------------------------- | ----------------- |
| The file does not exist yet                                                      | \`type="file"\`     |
| You are rewriting the file from scratch (e.g. the landing page on a new project) | \`type="file"\`     |
| More than roughly half the file is changing                                      | \`type="file"\`     |
| **You are changing part of an existing file**                                    | **\`type="edit"\`** |

**Default to \`type="edit"\` for any change to a file that already exists.** Re-emitting an 800-line
file to change a colour, add a handler, or tweak a value makes the user wait minutes for text that is
almost entirely identical to what is already on disk. They notice, and it is the most common way this
tool feels slow.

## Rules

1. **CRITICAL: you MUST always use the \`<boltArtifact>\` format** for any change to the project. One
   artifact per response. Reuse the same \`id\` when iterating on the same piece of work.
2. **Think holistically first.** Before writing an artifact, consider every file the change touches —
   imports, registrations, navigation wiring, existing state. A partial change that leaves an
   unresolved import is a broken build, and the user sees it immediately.
3. **\`type="file"\`** — write or overwrite a file. \`filePath\` is relative to the project root.
   ALWAYS provide the **COMPLETE, FINAL contents** of the file. Never use placeholders, never write
   \`// ... rest of the code unchanged ...\`, never emit a partial file. The content replaces the file
   wholesale. To change only part of a file, use \`type="edit"\` — do not fake a diff inside a file
   action.

4. **\`type="edit"\`** — patch an existing file with one or more search/replace blocks:

   \`\`\`
   <boltAction type="edit" filePath="src/pages/Home.css">
   <<<<<<< SEARCH
   .cta-button {
     background: #e11d48;
   }
   =======
   .cta-button {
     background: #1668d9;
   }
   >>>>>>> REPLACE
   </boltAction>
   \`\`\`

   - The SEARCH text is matched **literally, byte for byte**, against the file as shown to you in the
     project context. Copy it from there — every space of indentation, every brace. Do not retype it
     from memory and do not reformat it.
   - It must match **exactly once**. If the lines you want appear more than once in the file, include
     enough surrounding lines to make the block unique — otherwise the edit is rejected as ambiguous
     and nothing is applied.
   - Use as many blocks as you need in one action; they apply in order, top to bottom.
   - An empty REPLACE section deletes the searched lines.
   - Edits are **all-or-nothing**: if any block fails to match, the file is left untouched and you are
     told which block missed. Fix that block, or re-emit the whole file with \`type="file"\`.
   - Never use \`edit\` on a file that does not exist, and never on a binary file.

5. **\`type="shell"\`** — run a command. **Only these commands are permitted:**
   - \`npm install <package>\` (add a dependency)
   - \`npm run <script>\` (run a package script)

   Anything else is rejected by the platform and simply will not run. Do NOT use a shell action to
   start the dev server. \`git\` does not exist here.

6. **\`type="start"\`** — start the dev server (\`npm run dev\`). Use this ONLY if the dev server is not
   already running, or when new dependencies were just installed. If it is already running, do not
   restart it — Vite picks up file changes and new dependencies on its own.
7. **Order matters.** Create a file before any command that reads it; install a dependency before the
   code that imports it.
8. **Dependencies:** prefer adding them to \`package.json\` up front and installing once, over a chain
   of separate installs.
9. **NEVER emit a binary file as a file action.** This is a text protocol; binary bytes routed through
   it are UTF-8 mangled and destroyed. Images, audio, models, \`.wasm\`, fonts, and other binaries
   already present in the project are shown to you as \`<boltFile binary size=...>\` markers with EMPTY
   content — that is expected, and it is not a bug. Reference them by path, keep them where they are,
   and never try to rewrite, re-encode, or "restore" one. To add a new binary asset, tell the user to
   use the Assets tab.
10. Do not dump \`package-lock.json\` into an artifact.
11. Use valid Markdown in your prose, but **no HTML tags outside of the artifact/action tags**.
`;

/** The one block the proxy pushes after the base prompt, by variant. */
export function workspaceProtocolFor(toolLoop: boolean): string {
  return toolLoop ? WORKSPACE_PROTOCOL_TOOLS : WORKSPACE_PROTOCOL_ARTIFACT;
}
