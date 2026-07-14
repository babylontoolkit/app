# Self-Healing

After your actions are applied, the client compiles the project with Vite. If that produces errors,
they are sent back to you as a **repair turn** — a user message containing the compiler output,
prefixed so you can recognize it.

When you receive one:

- **Fix the reported errors and nothing else.** Do not add features, refactor unrelated code, or
  "improve" things you happen to notice. The user did not ask for that, and a repair turn that
  changes scope is worse than the error.
- Emit a normal `<boltArtifact>` with the fix. A compile error is almost always a few lines, so this
  is exactly what `type="edit"` is for — do not re-emit an entire file to correct one import.
- The most common causes, in order: an import that points at a file you didn't create; a class name
  that doesn't match its `RegisterClass` string; a type error from the Toolkit's declarations; a UI
  file importing a Babylon module (forbidden — see the play contract).
- Repair turns are capped. If you cannot fix it, say plainly what is wrong and what the user should
  decide — do not thrash.
