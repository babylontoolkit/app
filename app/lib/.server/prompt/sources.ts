/**
 * Doc-sync source map (SPEC §4.3, spec/doc-sync.md).
 *
 * The Agent Reference repo (`babylontoolkit/agent`) is the single editable source of domain
 * knowledge; this platform only ever reads SNAPSHOTS of it. Nothing here is fetched at generation
 * time — that is a hard rule (SPEC §1.3 principle 3). These URLs are read by the doc-sync BUILD,
 * whose output is stored as a `prompt_versions` row and served from our own store forever after.
 */

export const AGENT_REPO = 'babylontoolkit/agent';
export const SKILLS_REPO = 'babylontoolkit/skills';

const RAW = (repo: string, path: string) => `https://raw.githubusercontent.com/${repo}/main/${path}`;

export interface DocSource {
  /** Stable id — used in logs, as the cache-block key, and as `load_reference`'s argument. */
  id: string;
  path: string;
  url: string;
}

export interface OnDemandBlock extends DocSource {
  /** Human label shown in the block header handed to the model. */
  title: string;

  /**
   * 🔴 **THE TRIGGER. The MODEL reads this and decides — there is no keyword router (2026-08-08).**
   *
   * This replaces a `keywords: string[]` substring table, and it is the fourth time this codebase has
   * removed one (skills router, landing-pass rule, genre inference, this). Every failure of the doc
   * table was silent and measurable:
   *
   *   - it matched `'touch'` inside `"untouched defaults"` and `'video'` inside `generate_video`;
   *   - it ran against the platform's own HIDDEN creation brief, not the user's request, so **every
   *     creation received the same ten documents** — 61.6k tokens, `racing-system` included, whether
   *     the user asked for a kart racer or a chess game. Measured 2026-08-07: routing on
   *     `"mario kart racer clone"` and on `"a chess puzzle game"` produced byte-identical block sets;
   *   - the phrase `"make me a kart racing game"`, added to that brief as an EXAMPLE on 2026-08-06,
   *     pulled the racing corpus into every project on the platform by itself.
   *
   * So write this the way `SKILL.md` descriptions are written: state what the document covers and when
   * a task needs it, in the language a model would use to describe its own task. A doc the model never
   * loads almost always has a weak description — fix the description, not a table.
   *
   * ⚠️ It must NEVER become a machine-matched field. `no-prompt-classifier.spec.ts` fails the build if
   * any code substring-matches user text to pick a document.
   */
  description: string;
}

/**
 * 🔴 THE ONLY DOCUMENTS BAKED INTO EVERY PROMPT — two of them, and each earns it (Phase 2, 2026-08-08).
 *
 * This list used to hold eight docs, ~106KB, welded into the cached prefix of every generation whether
 * the turn was a creation, a one-line CSS tweak or a question. Measured on the live prompt version:
 * the base prompt was **137,979 chars, only 27% of it the platform's own rules** — the rest was Babylon
 * Toolkit documentation, including 13,731 bytes of guidance for platforms this is not (a **Next.js**
 * full-stack guide and a **Lovable** TanStack adapter, in a Vite + React project — worse than waste,
 * since it teaches patterns that do not apply here).
 *
 * ## What decided the design
 *
 * `reference.md` — the ROUTER INDEX below — was ALREADY baked, and it says, in capitals:
 *
 *   > ALWAYS READ THIS ENTIRE DOCUMENT TO THE END, THEN FETCH THE MATCHING SUB-DOCUMENTS.
 *   > You MUST fetch and read the matching sub-document(s) below BEFORE answering…
 *   > If any fetch fails, STOP immediately and tell the user.
 *
 * **The model had no fetch tool.** It was handed a mandatory routing table it could not act on, while
 * the platform keyword-matched some of the same documents behind its back and pasted them in. So this
 * is not a new architecture and there was no index to invent: the missing piece was one tool
 * (`load_reference`, `agent/reference-tools.ts`), and the docs it reads are the SAME pinned, synced,
 * admin-promoted snapshot the baked ones came from — strictly better than a live fetch, which can fail
 * mid-generation.
 *
 * ## Why exactly these two stay
 *
 *   - **`reference`** is the index itself. It has to be in front of the model for any of the rest to be
 *     reachable, and it is the document the Agent Reference repo maintains for precisely that purpose.
 *   - **`platform-host`** answers "what host am I running on?", which is wrong by default and wrong
 *     expensively: `project-installer.md` runs a BLOCKING platform-detection procedure whose table
 *     resolves us to **Bolt.new** (its signal is "running in a StackBlitz WebContainer" — which is us),
 *     pointing at a doc we do not sync and instructing a `StarterAssets.git` clone that cannot work
 *     here. `web-app-builder.md` is OUR row: starter already mounted, nothing to clone, no network.
 *     A doc that prevents a wrong action on every turn is not the same kind of thing as a doc that
 *     helps when the task needs it, and only the second kind can be loaded on demand.
 *
 * `references/classic.md` remains deliberately EXCLUDED from the whole system — UMD/`<script>`-tag
 * style, and this platform is ESM-only. Including it invites the model to emit UMD code.
 */
export const BASE_DOCS: DocSource[] = [
  { id: 'reference', path: 'reference.md', url: RAW(AGENT_REPO, 'reference.md') },
  { id: 'platform-host', path: 'references/web-app-builder.md', url: RAW(AGENT_REPO, 'references/web-app-builder.md') },
];

/**
 * Kept out of the base prefix and appended only when keyword-routed in. This is what keeps the
 * cached prefix stable (and therefore cheap) while still giving the model deep system docs when a
 * request actually needs them.
 *
 * EVERY doc a baked reference points at must be reachable from here, or the pointer is a lie: the
 * Agent Reference docs are NOT pulled live at generation time (the `web_fetch` tool is for arbitrary
 * user-referenced URLs, never the pinned routed docs), so a doc that is neither baked nor routed simply
 * does not exist for the model — which is told the routing step is already complete and never to report
 * a failed fetch. The result is silent improvisation in the exact area the doc was meant to cover.
 *
 * `references/skills-repository.md` is the one deliberate exception: it instructs an agent to copy
 * skill folders into the project (`.claude/skills`, plugin marketplaces), which is a DIFFERENT host's
 * mechanism. Here the server pre-loads skills into the cached prefix or serves them via `load_skill`
 * (§4.11), so that doc would actively mislead. It stays unsynced and the platform-identity section
 * neutralizes the router's pointer to it.
 */
export const ON_DEMAND_BLOCKS: OnDemandBlock[] = [
  /*
   * ---------------------------------------------------------------------------------------------
   * The six core references. UNBAKED 2026-08-08 (Phase 2) — they were ~106KB of every single prompt.
   * -------------------------------------------------------------------------------------------
   */

  {
    id: 'react-framework',
    title: 'React Framework Integration',
    path: 'references/react-framework.md',
    url: RAW(AGENT_REPO, 'references/react-framework.md'),

    /*
     * ⚠️ This file also contains a **Next.js** full-stack guide (10,366 B) and a **Lovable** TanStack
     * adapter (3,365 B) — 13,731 bytes describing platforms this is not, which used to ride in every
     * prompt. Unbaking resolves it here; the SPLIT is worth reporting upstream, since the doc is
     * authored in `babylontoolkit/agent` and is not ours to edit.
     */
    description:
      'How a Babylon Toolkit scene lives inside a React app: BabylonSceneViewer, SceneController, ' +
      'BabylonMount, createScene, the CustomOverlay layer, and how React UI talks to game code. ' +
      'Load this before writing or changing any .tsx that mounts, wraps or overlays a 3D scene.',
  },
  {
    id: 'ui-design-system',
    title: 'User Interface Instructions',
    path: 'references/ui-design-system.md',
    url: RAW(AGENT_REPO, 'references/ui-design-system.md'),
    description:
      'The UI architecture: the Scene Viewer’s three layers, the z-index stack, CustomOverlay, and the ' +
      'decision matrix for choosing DOM/React UI versus GPU GUI drawn into the scene. Load this for ' +
      'any HUD, menu, landing page, overlay or on-screen interface work.',
  },
  {
    id: 'scene-components',
    title: 'Interactive Scene Content',
    path: 'references/scene-components.md',
    url: RAW(AGENT_REPO, 'references/scene-components.md'),
    description:
      'How scene content is authored and driven: entities, components, and the pieces that make a ' +
      'loaded scene interactive. Load this when building or modifying what is IN the 3D scene.',
  },
  {
    id: 'training-reference',
    title: 'Agent Training Reference',
    path: 'references/training-reference.md',
    url: RAW(AGENT_REPO, 'references/training-reference.md'),
    description:
      'Index of the worked training examples and playgrounds, with guidance on checking for a matching ' +
      'example before writing code from scratch. Load this when you want a known-good pattern to copy.',
  },
  {
    id: 'components-overview',
    title: 'Component Reference Overview',
    path: 'training/components/README.md',
    url: RAW(AGENT_REPO, 'training/components/README.md'),
    description:
      'Overview of the fourteen Toolkit system components and what each one is for. Load this when you ' +
      'know you need a component but not which one — it is the map to the per-component references.',
  },
  {
    id: 'node-esm',
    title: 'Node & ESM Module Usage',
    path: 'references/node-esm.md',
    url: RAW(AGENT_REPO, 'references/node-esm.md'),
    description:
      'ESM import style, module resolution and package entry points for Toolkit code in a Vite ' +
      'project. Load this when imports fail to resolve or when adding a new module boundary.',
  },

  /*
   * ---------------------------------------------------------------------------------------------
   * Everything below has always been on demand.
   * -------------------------------------------------------------------------------------------
   */

  /*
   * UNBAKED 2026-07-16 — measured at 11,987 tokens, 19.8% of the entire cached prefix, on EVERY
   * request. Its STEP 0 is a BLOCKING platform-detection + `StarterAssets.git` cloning procedure that
   * this platform must never run: the starter template is mounted before the agent's first turn, and
   * `git` does not exist in WebContainer. A fifth of every request was teaching a procedure the
   * platform forbids — not dead weight but CONTRADICTION, the most expensive kind of token.
   *
   * It stays reachable because its package lists, version pins, and content-creation-tool sections
   * are genuinely useful when a request is actually about installing something.
   *
   * ⚠️ Loading it on demand does NOT resolve the contradiction — a build turn can legitimately want
   * the package list and get the clone procedure with it. The BAKED platform-identity section carries
   * the standing "already scaffolded, never clone" rule, so the override is present on every turn
   * whether or not this doc is loaded. Do not remove it. The description below says so too, because
   * the model choosing to load this should already know which half to ignore.
   */
  {
    id: 'project-installer',
    title: 'Project Installation & Packages',
    path: 'references/project-installer.md',
    url: RAW(AGENT_REPO, 'references/project-installer.md'),
    description:
      'Toolkit package names, version pins, dependency lists and content-creation tooling. Load this ' +
      'when adding or upgrading a package. NOTE: its platform-detection and StarterAssets cloning ' +
      'steps do not apply here — this project is already scaffolded and there is no network or git.',
  },

  /*
   * `references/react-framework.md` tells the model to "always reference" this doc — so it must be
   * reachable. At ~55KB it is the largest prose doc in the repo.
   */
  {
    id: 'react-training',
    title: 'React Framework — Agentic AI Game Builder Reference',
    path: 'training/react/README.md',
    url: RAW(AGENT_REPO, 'training/react/README.md'),
    description:
      'The long-form React + Toolkit game-builder walkthrough: full worked examples of GameManager, ' +
      'scene controllers, HUD wiring and page-to-gameplay navigation. Deeper than react-framework — ' +
      'load it when building a frontend end to end rather than changing one component.',
  },
  {
    id: 'shader-materials',
    title: 'Shader Materials',
    path: 'references/shader-materials.md',
    url: RAW(AGENT_REPO, 'references/shader-materials.md'),
    description:
      'Authoring custom shader materials: the CustomShaderMaterial + MaterialPluginBase pair, the ' +
      'GLSL and WGSL injection points, and the shipped materials you should reuse instead of writing ' +
      'a shader (terrain splatmaps, waving grass, tree branches, vertex-animated crowds, per-skin ' +
      'texture arrays, water, sky). Load this for any custom material, shader effect or vegetation.',
  },
  {
    id: 'scene-manager',
    title: 'SceneManager',
    path: 'training/components/01-SceneManager.md',
    url: RAW(AGENT_REPO, 'training/components/01-SceneManager.md'),
    description:
      'SceneManager: loading scenes, the scene lifecycle, and how a GameMode is registered and ' +
      'entered. Load this when creating a new game mode or changing how scenes are loaded or switched.',
  },
  {
    id: 'script-component',
    title: 'ScriptComponent',
    path: 'training/components/02-ScriptComponent.md',
    url: RAW(AGENT_REPO, 'training/components/02-ScriptComponent.md'),
    description:
      'ScriptComponent: RegisterClass, the awake/start/update lifecycle, and exposed script ' +
      'properties. This is the base class for essentially all gameplay code — load it before writing ' +
      'anything in src/scripts/.',
  },
  {
    id: 'animation-state',
    title: 'AnimationState',
    path: 'training/components/03-AnimationState.md',
    url: RAW(AGENT_REPO, 'training/components/03-AnimationState.md'),
    description:
      'AnimationState: Mecanim-style state machines, blend trees, transitions and driving character ' +
      'animation from gameplay state. Load this for walk cycles, attack animations or any animator.',
  },
  {
    id: 'character-controller',
    title: 'CharacterController',
    path: 'training/components/04-CharacterController.md',
    url: RAW(AGENT_REPO, 'training/components/04-CharacterController.md'),
    description:
      'CharacterController: moving a player or NPC with collision — walking, running, jumping, ' +
      'grounding, and first- or third-person camera rigs. Load this for any on-foot player movement.',
  },
  {
    id: 'navigation-agent',
    title: 'NavigationAgent',
    path: 'training/components/05-NavigationAgent.md',
    url: RAW(AGENT_REPO, 'training/components/05-NavigationAgent.md'),
    description:
      'NavigationAgent: navmesh generation (Recast/Detour), pathfinding and steering. Load this for ' +
      'enemy AI that chases or patrols, or anything that must walk a path around obstacles.',
  },
  {
    id: 'rigidbody-physics',
    title: 'RigidbodyPhysics',
    path: 'training/components/06-RigidbodyPhysics.md',
    url: RAW(AGENT_REPO, 'training/components/06-RigidbodyPhysics.md'),
    description:
      'RigidbodyPhysics on Havok: rigid bodies, colliders, triggers, joints, gravity, forces and ' +
      'ragdolls. Load this for anything that falls, collides, bounces or is pushed.',
  },
  {
    id: 'audio-source',
    title: 'AudioSource',
    path: 'training/components/07-AudioSource.md',
    url: RAW(AGENT_REPO, 'training/components/07-AudioSource.md'),
    description:
      'AudioSource: playing music and sound effects, spatial/3D audio, and audio lifecycle. Load this ' +
      'for any sound work.',
  },
  {
    id: 'materials',
    title: 'Materials',
    path: 'training/components/08-Materials.md',
    url: RAW(AGENT_REPO, 'training/components/08-Materials.md'),
    description:
      'Standard and PBR materials, textures, lighting, skyboxes and reflections. Load this to change ' +
      'how something LOOKS without writing a custom shader.',
  },
  {
    id: 'input-controller',
    title: 'InputController',
    path: 'training/components/09-InputController.md',
    url: RAW(AGENT_REPO, 'training/components/09-InputController.md'),

    /*
     * ⚠️ The doc this points at taught `GetKeyDown`/`GetKeyUp`/`GetKeyPress` — Unity `Input` names that
     * have NEVER existed in the runtime — and three consecutive generations shipped games that crashed
     * in `update()`. Fixed at source (`babylontoolkit/agent@2025c9c`, 2026-08-05). Naming the real API
     * here is belt-and-braces, and it is also exactly what a description is for.
     */
    description:
      'InputController: reading keyboard, mouse, gamepad and touch input — GetKeyboardInput, ' +
      'IsKeyboardButtonHeld, WasKeyboardButtonTapped, virtual joysticks. Load this before wiring ANY ' +
      'controls; the input API does not match Unity’s and guessing at it crashes at runtime.',
  },
  {
    id: 'pro-components',
    title: 'ProComponents',
    path: 'training/components/10-ProComponents.md',
    url: RAW(AGENT_REPO, 'training/components/10-ProComponents.md'),
    description:
      'The Pro component set: terrain systems, video playback surfaces and other advanced components. ' +
      'Load this for large outdoor terrain or in-world video.',
  },
  {
    id: 'enums-interfaces',
    title: 'Enums & Interfaces',
    path: 'training/components/11-Enums-Interfaces.md',
    url: RAW(AGENT_REPO, 'training/components/11-Enums-Interfaces.md'),
    description:
      'The Toolkit’s enums and TypeScript interfaces, with their exact member names. Load this when ' +
      'you need the precise spelling of an enum value rather than an approximation.',
  },
  {
    id: 'starter-content',
    title: 'StarterContent',
    path: 'training/components/12-StarterContent.md',
    url: RAW(AGENT_REPO, 'training/components/12-StarterContent.md'),
    description:
      'The starter content shipped with the template: demo scenes, prefabs and sample assets already ' +
      'present in the project. Load this to reuse what is on disk instead of authoring from scratch.',
  },
  {
    id: 'racing-system',
    title: 'RacingSystem',
    path: 'training/components/13-RacingSystem.md',
    url: RAW(AGENT_REPO, 'training/components/13-RacingSystem.md'),
    description:
      'RacingSystem: vehicle physics, wheel colliders, steering and throttle, track layout, waypoints ' +
      'and lap timing. Load this for cars, karts or any driven vehicle.',
  },
  {
    id: 'game-patterns',
    title: 'GamePatterns',
    path: 'training/components/14-GamePatterns.md',
    url: RAW(AGENT_REPO, 'training/components/14-GamePatterns.md'),
    description:
      'Common game structures: the game loop, score, health, lives, inventory, pickups, spawning, ' +
      'level progression and menu flow. Load this for the rules and state around the gameplay itself.',
  },

  /*
   * MCP image/video/texture generation (kie.ai). MCP servers run in the USER's WebContainer
   * (§4.14, §5) — never on platform infra.
   */
  {
    id: 'kie-servers',
    title: 'Image And Video Generation (MCP)',
    path: 'references/web-kie-servers.md',
    url: RAW(AGENT_REPO, 'references/web-kie-servers.md'),
    description:
      'Configuring the kie.ai MCP servers in a project’s .mcp.json for image, video and texture ' +
      'generation. NOTE: this platform already gives you built-in generate_image/generate_video ' +
      'tools — load this only when the user is setting up their OWN MCP server.',
  },

  /*
   * The `@babylonjs/gui` API reference (agent repo, 2026-07-16 split).
   *
   * `ui-design-system.md` was 15,595 tokens — 31% of the whole cached prefix, and the single largest
   * doc we bake. Compacting its prose could never pay: it is 66% code fences. The real shape of it was
   * that TWO documents were living in one file — the UI *architecture* (the Scene Viewer's three
   * layers, the z-index stack, `CustomOverlay`) which nearly every UI turn needs, and the complete GPU
   * GUI *API reference* which most turns never touch. A landing page, a React HUD, a gameplay tweak:
   * none of them need `AdvancedDynamicTexture`. Splitting on that seam took the baked doc to 7,739
   * tokens (−50%) with no prose rewritten and nothing lost.
   *
   * **The decision matrix stayed BAKED on purpose** — it is the routing brain ("health bar above a 3D
   * character → GPU GUI, `linkWithMesh`"), so the agent still knows GPU GUI is the right answer even on
   * a turn where this block does not load. And because a false-negative here is otherwise SILENT, the
   * baked doc now ends with an explicit instruction: if you need the GPU GUI API and this reference is
   * not in front of you, SAY SO — never reconstruct the API from general BabylonJS knowledge.
   *
   * The description names the situations the decision matrix itself says require GPU GUI, so the model
   * can recognise its own task in them.
   */
  {
    id: 'babylon-gui',
    title: 'BabylonJS GUI (@babylonjs/gui) API Reference',
    path: 'references/babylon-gui.md',
    url: RAW(AGENT_REPO, 'references/babylon-gui.md'),
    description:
      'The @babylonjs/gui API: AdvancedDynamicTexture, CreateFullscreenUI, CreateForMesh, ' +
      'linkWithMesh, TextBlock, StackPanel and the rest. This is GPU GUI — UI drawn INSIDE the 3D ' +
      'scene, which DOM cannot do: health bars and name plates above characters, damage numbers, ' +
      'cockpit displays, in-world screens, minimaps, and any WebXR/VR interface (DOM is invisible in ' +
      'VR). Load it before writing GPU GUI — never reconstruct this API from general BabylonJS ' +
      'knowledge, and say so if you need it and do not have it.',
  },

  /*
   * Playground examples. `references/training-reference.md` lists these five by URL and says "Check
   * for a matching example before writing code from scratch" — an instruction that was impossible to
   * follow until they were synced, and that `load_reference` finally makes literally true.
   */
  {
    id: 'demo-rotator',
    title: 'Playground: DemoRotator (minimal ScriptComponent)',
    path: 'training/playgrounds/01-DemoRotator.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/01-DemoRotator.md'),
    description:
      'Worked example: the simplest possible ScriptComponent, spinning a mesh in update(). The ' +
      'smallest complete pattern for "make this thing move every frame".',
  },
  {
    id: 'demo-bobber',
    title: 'Playground: DemoBobber (parameterized motion)',
    path: 'training/playgrounds/02-DemoBobber.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/02-DemoBobber.md'),
    description:
      'Worked example: oscillating motion driven by exposed script properties — the pattern for a ' +
      'component whose behaviour is tunable rather than hardcoded.',
  },
  {
    id: 'demo-user-input',
    title: 'Playground: DemoUserInput (input-driven movement)',
    path: 'training/playgrounds/03-DemoUserInput.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/03-DemoUserInput.md'),
    description:
      'Worked example: moving an object from keyboard and mouse input (WASD, mouse look). The ' +
      'shortest correct example of the real input API.',
  },
  {
    id: 'demo-player-scene',
    title: 'Playground: DemoPlayerScene (async load + physics + player)',
    path: 'training/playgrounds/04-DemoPlayerScene.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/04-DemoPlayerScene.md'),
    description:
      'Worked example: a complete playable scene — async scene load, physics, and a controllable ' +
      'character wired together. The reference shape for an on-foot game mode.',
  },
  {
    id: 'demo-vehicle-scene',
    title: 'Playground: DemoVehicleScene (async load + physics + vehicle)',
    path: 'training/playgrounds/05-DemoVehicleScene.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/05-DemoVehicleScene.md'),
    description:
      'Worked example: a complete drivable scene — async load, physics and a working vehicle ' +
      'controller. The reference shape for a racing or driving game mode.',
  },
];

/**
 * Synced for editor IntelliSense (§4.1) and available to the agent on demand — NEVER baked into
 * the base prompt. `babylon.toolkit.d.ts` alone is ~490KB (~130k tokens); putting it in the cached
 * prefix would dwarf every other cost in the system.
 */
export const DECLARATION_FILES: DocSource[] = [
  {
    id: 'babylon.toolkit.d.ts',
    path: 'training/declarations/babylon.toolkit.d.ts',
    url: RAW(AGENT_REPO, 'training/declarations/babylon.toolkit.d.ts'),
  },
  {
    id: 'default.playground.d.ts',
    path: 'training/declarations/default.playground.d.ts',
    url: RAW(AGENT_REPO, 'training/declarations/default.playground.d.ts'),
  },
];

/**
 * 🔴 THERE IS NO DOC ROUTER. `selectOnDemandBlocks` AND `selectStickyBlocks` ARE DELETED (2026-08-08).
 *
 * This note is a headstone, not a TODO. Both functions existed to answer "which documents does this
 * request need?" by substring-matching the conversation, and the answer is now the MODEL's, made from
 * the `description` field above via `load_reference` (`agent/reference-tools.ts`) — the same fix this
 * codebase applied to SKILLS on 2026-07-26, measured then at 6 rounds / 29,173 output tokens → 1 round
 * / 122 tokens.
 *
 * ## Why the sticky-and-append-only machinery went with them
 *
 * `selectStickyBlocks` was a real fix to a real money bug: routed blocks sat in the CACHED PREFIX, so
 * per-message routing let the user's choice of words set the price of their edit (measured: the same
 * trivial change costing 12 credits and then 160, because the second phrasing said "racing track").
 * Stickiness fixed that by making the set only ever grow, in first-seen order, so the prefix appended
 * rather than rewrote.
 *
 * It was the correct fix to the wrong problem. The blocks were in the prefix because the platform was
 * guessing at them ahead of time and had to guess EARLY — and a guess made from the platform's own
 * hidden creation brief was never going to be about the user's request at all. Once the model asks for
 * what it needs, mid-generation, there is no prefix churn to defend against, and stickiness moves to
 * where it belongs: `carriedReferenceIds`, which carries what the model ACTUALLY loaded into the next
 * turn's cached prefix, append-only and first-seen, for the same reasons and with the same rules.
 *
 * **Do not resurrect a keyword table here or anywhere else.** `no-prompt-classifier.spec.ts` fails the
 * build if any code picks a document, a skill or a code path by substring-matching user text.
 */

/**
 * 🔴 A DOC THAT THE ROUTER INDEX POINTS AT AND THIS PLATFORM DELIBERATELY DOES NOT SERVE.
 *
 * `reference.md` is authored in `babylontoolkit/agent` for every host, so its routing table names
 * documents that are correct elsewhere and wrong here. It is BAKED into our prompt, and since Phase 2
 * the model has a tool — so it will follow that table and ask. Answering "no reference named classic"
 * is technically true and actively misleading: it reads as a platform fault, and the model's next move
 * is to improvise the very thing the exclusion exists to prevent.
 *
 * So the exclusions are NAMED, with the reason the model needs in order to do the right thing instead.
 * The alternative — syncing them so the id resolves — would defeat the point of excluding them.
 */
export const EXCLUDED_REFERENCES: Record<string, string> = {
  classic:
    'That document teaches the UMD / <script>-tag style. This platform is ESM-only (Vite + TypeScript), ' +
    'so it is deliberately not available: follow the ES6 guidance instead and never emit UMD code or a ' +
    'global BABYLON namespace.',
  'skills-repository':
    'That document tells an agent to copy skill folders into `.claude/skills`, which is a DIFFERENT ' +
    "host's mechanism. Here the platform serves skills directly — see the Available Skills index in " +
    'your context and call `load_skill(name)`. There is nothing to install.',
};

/**
 * Resolve whatever the model actually typed into a reference id.
 *
 * 🔴 **THIS EXISTS BECAUSE THE AGENT REFERENCE IS WRITTEN IN URLs, AND WE SERVE IDs.** Measured across
 * the corpus: **90 cross-document references in 12 files**, every one of them phrased as *"Always
 * reference the Babylon Toolkit Component Reference at https://raw.githubusercontent.com/…"*. Those
 * instructions are correct in VS Code, where the model can fetch. On this platform the same sentence
 * used to be unfollowable, and after Phase 2 it became *nearly* followable — the document is right
 * there behind `load_reference`, under a name the doc never mentions.
 *
 * Accepting the URL closes that gap **without one byte changing in `babylontoolkit/agent`**, which is
 * the whole point: the docs stay correct for VS Code, Copilot and every other host, and they become
 * literally executable here. A model that reads "fetch <url>" and calls `load_reference('<url>')` is
 * doing exactly as it was told.
 *
 * Four accepted spellings, in the order a model produces them: the id from our index; the full raw
 * URL (copied from a doc); the repo-relative path; and the bare filename. Nothing clever — no fuzzy
 * matching, no scoring, no nearest-neighbour. An argument that does not resolve exactly returns null
 * and the tool lists what exists, because a WRONG document delivered confidently is worse than a
 * refusal that names the alternatives.
 *
 * ⚠️ **This is not the banned prompt classifier and the distinction is exact:** it matches a string the
 * MODEL supplied naming a document it explicitly asked for, against a fixed table of document names —
 * the same operation as `store.getActive(name)` for skills. The ban is on reading the USER's words to
 * decide what the model is TOLD. Nothing here ever sees a user's message.
 */
export function resolveReferenceId(wanted: string, blocks: OnDemandBlock[] = ON_DEMAND_BLOCKS): string | null {
  const normalized = wanted
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    return null;
  }

  for (const block of blocks) {
    const path = block.path.toLowerCase();
    const file = path.slice(path.lastIndexOf('/') + 1);
    const stem = file.replace(/\.md$/, '');

    /*
     * The last clause catches a URL carrying the trailing punctuation of the sentence it sat in — the
     * corpus really does contain `…/training/components/README.md.` at the end of a prose sentence, and
     * a model quoting it verbatim would otherwise get a refusal for a document we hold.
     */
    const suffixMatch = normalized.replace(/[.,;:)\]]+$/, '').endsWith(`/${path}`);

    if (
      normalized === block.id.toLowerCase() ||
      normalized === path ||
      normalized === file ||
      normalized === stem ||
      normalized === block.url.toLowerCase() ||
      suffixMatch
    ) {
      return block.id;
    }
  }

  return null;
}

/**
 * The reason this platform does not serve a document the router index names — or null if it is simply
 * not a name we know. Same tolerant spelling as `resolveReferenceId`, because the model will ask for an
 * excluded document using the URL the index gave it.
 */
export function excludedReferenceReason(wanted: string): string | null {
  const normalized = wanted.trim().toLowerCase();

  for (const [id, reason] of Object.entries(EXCLUDED_REFERENCES)) {
    if (normalized === id || normalized.replace(/[.,;:)\]]+$/, '').endsWith(`/references/${id}.md`)) {
      return reason;
    }
  }

  return null;
}
