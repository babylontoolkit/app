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
  /** Stable id — used in logs and (for on-demand blocks) as the cache-block key. */
  id: string;
  path: string;
  url: string;
}

export interface OnDemandBlock extends DocSource {
  /** Human label shown in the block header handed to the model. */
  title: string;

  /**
   * Lowercase keywords routed against the user's request. A hit appends this block to the
   * generation as a SEPARATE cached block, leaving the base prefix byte-identical (§4.3.6).
   */
  keywords: string[];
}

/**
 * Baked into the base prompt, in this order.
 *
 * `references/classic.md` is deliberately EXCLUDED — that is the UMD/`<script>`-tag style, and
 * this platform is ESM-only. Including it invites the model to emit UMD code.
 */
export const BASE_DOCS: DocSource[] = [
  { id: 'reference', path: 'reference.md', url: RAW(AGENT_REPO, 'reference.md') },
  { id: 'node-esm', path: 'references/node-esm.md', url: RAW(AGENT_REPO, 'references/node-esm.md') },
  {
    id: 'scene-components',
    path: 'references/scene-components.md',
    url: RAW(AGENT_REPO, 'references/scene-components.md'),
  },
  {
    id: 'react-framework',
    path: 'references/react-framework.md',
    url: RAW(AGENT_REPO, 'references/react-framework.md'),
  },
  {
    id: 'ui-design-system',
    path: 'references/ui-design-system.md',
    url: RAW(AGENT_REPO, 'references/ui-design-system.md'),
  },
  {
    id: 'training-reference',
    path: 'references/training-reference.md',
    url: RAW(AGENT_REPO, 'references/training-reference.md'),
  },

  /*
   * PLATFORM DETECTION (SPEC §4.3): `project-installer.md` runs a BLOCKING platform-detection
   * procedure mapping each host to a reference doc. We used to bake GENERIC as a stand-in, which was
   * wrong twice over: generic still says to clone `StarterAssets.git`, and the detection table
   * resolved us to **Bolt.new** anyway (its signal is "running in a StackBlitz WebContainer" — which
   * is us), pointing at a doc we do not sync.
   *
   * `web-app-builder.md` is OUR host row (agent repo, 2026-07-16): it says the starter is already
   * mounted, there is nothing to clone, there is no network, and skills are pre-loaded. Cheap enough
   * to bake and correct on every turn. The always-baked platform-identity section states the same
   * no-clone rule independently — belt and braces, since this doc is authored in another repo.
   */
  { id: 'platform-host', path: 'references/web-app-builder.md', url: RAW(AGENT_REPO, 'references/web-app-builder.md') },

  // Component Reference OVERVIEW is baked; the 14 system docs below are on-demand.
  {
    id: 'components-overview',
    path: 'training/components/README.md',
    url: RAW(AGENT_REPO, 'training/components/README.md'),
  },
];

/**
 * Kept out of the base prefix and appended only when keyword-routed in. This is what keeps the
 * cached prefix stable (and therefore cheap) while still giving the model deep system docs when a
 * request actually needs them.
 *
 * EVERY doc a baked reference points at must be reachable from here, or the pointer is a lie: there
 * is no network at generation time, so a doc that is neither baked nor routed simply does not exist
 * for the model — which is told the routing step is already complete and never to report a failed
 * fetch. The result is silent improvisation in the exact area the doc was meant to cover.
 *
 * `references/skills-repository.md` is the one deliberate exception: it instructs an agent to copy
 * skill folders into the project (`.claude/skills`, plugin marketplaces), which is a DIFFERENT host's
 * mechanism. Here the server pre-loads skills into the cached prefix or serves them via `load_skill`
 * (§4.11), so that doc would actively mislead. It stays unsynced and the platform-identity section
 * neutralizes the router's pointer to it.
 */
export const ON_DEMAND_BLOCKS: OnDemandBlock[] = [
  /*
   * UNBAKED 2026-07-16 — measured at 11,987 tokens, 19.8% of the entire cached prefix, on EVERY
   * request. Its STEP 0 is a BLOCKING platform-detection + `StarterAssets.git` cloning procedure that
   * this platform must never run: the starter template is mounted before the agent's first turn, and
   * `git` does not exist in WebContainer. A fifth of every request was teaching a procedure the
   * platform forbids — not dead weight but CONTRADICTION, the most expensive kind of token.
   *
   * It stays reachable because its package lists, version pins, and content-creation-tool sections
   * are genuinely useful when a request is actually about installing something. Keywords are the
   * agent repo's own Reference Index row, verbatim.
   *
   * ⚠️ Routing alone does NOT resolve the contradiction — a creation turn ("new project", "scaffold")
   * matches these keywords and pulls the clone procedure back in at the worst possible moment. The
   * BAKED platform-identity section carries the standing "already scaffolded, never clone" rule, so
   * the override is present on every turn whether or not this block routes in. Do not remove it.
   */
  {
    id: 'project-installer',
    title: 'Project Installation & Packages',
    path: 'references/project-installer.md',
    url: RAW(AGENT_REPO, 'references/project-installer.md'),
    keywords: [
      'new project',
      'scaffold',
      'setup',
      'install toolkit',
      'npm package',
      'npm install',
      'package version',
      'git submodule',
      'starter asset',
      'starter repo',
      'starterassets',
      'vercelassets',
      'project deployment',
      'add a package',
      'dependency',
    ],
  },

  /*
   * `references/react-framework.md` is BAKED and tells the model to "always reference" this doc — so
   * it must be reachable. Deliberately not baked itself: at ~55KB it is the largest prose doc in the
   * repo, and the baked React reference already covers the common path.
   */
  {
    id: 'react-training',
    title: 'React Framework — Agentic AI Game Builder Reference',
    path: 'training/react/README.md',
    url: RAW(AGENT_REPO, 'training/react/README.md'),
    keywords: [
      'react',
      'jsx',
      'tsx',
      'hook',
      'scenecontroller',
      'scene controller',
      'babylonsceneviewer',
      'scene viewer',
      'babylonmount',
      'createscene',
      'gamemanager',
      'game manager',
      'custom overlay',
      'hud',
      'landing page',
      'home screen',
      'frontend',
      'web app',
    ],
  },
  {
    id: 'shader-materials',
    title: 'Shader Materials',
    path: 'references/shader-materials.md',
    url: RAW(AGENT_REPO, 'references/shader-materials.md'),
    keywords: ['shader', 'glsl', 'wgsl', 'node material', 'custom material', 'vertex shader', 'fragment shader'],
  },
  {
    id: 'scene-manager',
    title: 'SceneManager',
    path: 'training/components/01-SceneManager.md',
    url: RAW(AGENT_REPO, 'training/components/01-SceneManager.md'),
    keywords: ['scenemanager', 'scene manager', 'load scene', 'scene lifecycle', 'gamemode', 'game mode'],
  },
  {
    id: 'script-component',
    title: 'ScriptComponent',
    path: 'training/components/02-ScriptComponent.md',
    url: RAW(AGENT_REPO, 'training/components/02-ScriptComponent.md'),
    keywords: ['script component', 'scriptcomponent', 'registerclass', 'lifecycle', 'awake', 'behavior', 'component'],
  },
  {
    id: 'animation-state',
    title: 'AnimationState',
    path: 'training/components/03-AnimationState.md',
    url: RAW(AGENT_REPO, 'training/components/03-AnimationState.md'),
    keywords: ['animation', 'animator', 'mecanim', 'animationstate', 'blend tree', 'state machine', 'walk cycle'],
  },
  {
    id: 'character-controller',
    title: 'CharacterController',
    path: 'training/components/04-CharacterController.md',
    url: RAW(AGENT_REPO, 'training/components/04-CharacterController.md'),
    keywords: [
      'character controller',
      'charactercontroller',
      'player controller',
      'third person',
      'first person',
      'walk',
      'jump',
      'platformer',
    ],
  },
  {
    id: 'navigation-agent',
    title: 'NavigationAgent',
    path: 'training/components/05-NavigationAgent.md',
    url: RAW(AGENT_REPO, 'training/components/05-NavigationAgent.md'),
    keywords: ['navmesh', 'navigation', 'pathfinding', 'recast', 'detour', 'navigationagent', 'ai agent', 'enemy ai'],
  },
  {
    id: 'rigidbody-physics',
    title: 'RigidbodyPhysics',
    path: 'training/components/06-RigidbodyPhysics.md',
    url: RAW(AGENT_REPO, 'training/components/06-RigidbodyPhysics.md'),
    keywords: ['physics', 'rigidbody', 'havok', 'collider', 'collision', 'joint', 'gravity', 'ragdoll'],
  },
  {
    id: 'audio-source',
    title: 'AudioSource',
    path: 'training/components/07-AudioSource.md',
    url: RAW(AGENT_REPO, 'training/components/07-AudioSource.md'),
    keywords: ['audio', 'sound', 'music', 'audiosource', 'sfx', 'spatial audio'],
  },
  {
    id: 'materials',
    title: 'Materials',
    path: 'training/components/08-Materials.md',
    url: RAW(AGENT_REPO, 'training/components/08-Materials.md'),
    keywords: ['material', 'pbr', 'texture', 'lighting', 'skybox', 'reflection'],
  },
  {
    id: 'input-controller',
    title: 'InputController',
    path: 'training/components/09-InputController.md',
    url: RAW(AGENT_REPO, 'training/components/09-InputController.md'),
    keywords: ['input', 'keyboard', 'mouse', 'gamepad', 'controller', 'touch', 'mobile input', 'joystick'],
  },
  {
    id: 'pro-components',
    title: 'ProComponents',
    path: 'training/components/10-ProComponents.md',
    url: RAW(AGENT_REPO, 'training/components/10-ProComponents.md'),
    keywords: ['terrain', 'video', 'pro component', 'procomponents'],
  },
  {
    id: 'enums-interfaces',
    title: 'Enums & Interfaces',
    path: 'training/components/11-Enums-Interfaces.md',
    url: RAW(AGENT_REPO, 'training/components/11-Enums-Interfaces.md'),
    keywords: ['enum', 'interface', 'type definition'],
  },
  {
    id: 'starter-content',
    title: 'StarterContent',
    path: 'training/components/12-StarterContent.md',
    url: RAW(AGENT_REPO, 'training/components/12-StarterContent.md'),
    keywords: ['starter content', 'starter asset', 'prefab', 'demo scene', 'sample'],
  },
  {
    id: 'racing-system',
    title: 'RacingSystem',
    path: 'training/components/13-RacingSystem.md',
    url: RAW(AGENT_REPO, 'training/components/13-RacingSystem.md'),
    keywords: ['racing', 'race', 'car', 'vehicle', 'kart', 'drive', 'driving', 'wheel', 'track', 'lap'],
  },
  {
    id: 'game-patterns',
    title: 'GamePatterns',
    path: 'training/components/14-GamePatterns.md',
    url: RAW(AGENT_REPO, 'training/components/14-GamePatterns.md'),
    keywords: ['game pattern', 'game loop', 'score', 'health', 'inventory', 'menu', 'spawn', 'pickup', 'level'],
  },

  /*
   * MCP image/video/texture generation (kie.ai). Keywords are the agent repo's OWN Reference Index
   * row for this doc, copied verbatim — that table is the authoritative routing spec, and inventing
   * our own would drift from it silently.
   *
   * MCP servers run in the USER's WebContainer (§4.14, §5) — never on platform infra.
   */
  {
    id: 'kie-servers',
    title: 'Image And Video Generation (MCP)',
    path: 'references/web-kie-servers.md',
    url: RAW(AGENT_REPO, 'references/web-kie-servers.md'),
    keywords: [
      'mcp',
      'mcp server',
      '.mcp.json',
      'model context protocol',
      'kie.ai',
      'kie_key',
      '@babylonjs-toolkit/mcp',
      'kie-image-mcp',
      'image generation',
      'video generation',
      'texture generation',
      'generate an image',
      'generate a texture',
      'nano banana',
      'imagen',
      'flux',
      'seedream',
      'kling',
      'seedance',
      'grok imagine',
      'veo',
    ],
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
   * Keywords are taken from the decision matrix's own rows, not invented: they are the situations the
   * doc itself says require GPU GUI.
   */
  {
    id: 'babylon-gui',
    title: 'BabylonJS GUI (@babylonjs/gui) API Reference',
    path: 'references/babylon-gui.md',
    url: RAW(AGENT_REPO, 'references/babylon-gui.md'),
    keywords: [
      // The library and its API surface, by name.
      'babylon gui',
      '@babylonjs/gui',
      'babylonjs/gui',
      'gpu gui',
      'advanceddynamictexture',
      'fullscreen ui',
      'createfullscreenui',
      'createformesh',
      'linkwithmesh',
      'textblock',
      'stackpanel',
      'scrollviewer',
      'virtualkeyboard',
      'colorpicker',
      'layermask',
      'idealwidth',

      // The situations the decision matrix says GPU GUI owns.
      'health bar',
      'healthbar',
      'hp bar',
      'name tag',
      'nametag',
      'nameplate',
      'name plate',
      'damage number',
      'floating text',
      'floating label',
      'above the player',
      'above the character',
      'above their heads',
      'world space ui',
      'in-world ui',
      'in-world screen',
      'on a mesh',
      'onto a mesh',
      'cockpit',
      'cockpit display',
      'in-game monitor',
      'in-game screen',
      'billboard gui',
      'minimap',

      /*
       * WebXR: DOM is invisible in VR, so a VR interface is ALWAYS GPU GUI — the one row in the matrix
       * with no DOM option at all. Matching is `includes`, so a bare 'vr' is unusable (it fires on
       * "vroom", "servers", "swerve"); these are the phrasings that carry the meaning.
       */
      'webxr',
      'virtual reality',
      'in vr',
      'for vr',
      'vr mode',
      'vr ui',
      'vr interface',
      'vr headset',
      'vr panel',
    ],
  },

  /*
   * Playground examples. `references/training-reference.md` is BAKED, lists these five by URL, and
   * says "Check for a matching example before writing code from scratch" — an instruction that was
   * impossible to follow, since none of them were synced.
   */
  {
    id: 'demo-rotator',
    title: 'Playground: DemoRotator (minimal ScriptComponent)',
    path: 'training/playgrounds/01-DemoRotator.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/01-DemoRotator.md'),
    keywords: ['rotator', 'rotate', 'spin', 'simplest script', 'minimal script', 'first script'],
  },
  {
    id: 'demo-bobber',
    title: 'Playground: DemoBobber (parameterized motion)',
    path: 'training/playgrounds/02-DemoBobber.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/02-DemoBobber.md'),
    keywords: ['bobber', 'bob', 'oscillate', 'hover motion', 'script property', 'exposed property'],
  },
  {
    id: 'demo-user-input',
    title: 'Playground: DemoUserInput (input-driven movement)',
    path: 'training/playgrounds/03-DemoUserInput.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/03-DemoUserInput.md'),
    keywords: ['mouse look', 'user input', 'wasd', 'input driven', 'move the player'],
  },
  {
    id: 'demo-player-scene',
    title: 'Playground: DemoPlayerScene (async load + physics + player)',
    path: 'training/playgrounds/04-DemoPlayerScene.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/04-DemoPlayerScene.md'),
    keywords: ['player scene', 'async scene', 'load a scene', 'sample scene', 'demo scene'],
  },
  {
    id: 'demo-vehicle-scene',
    title: 'Playground: DemoVehicleScene (async load + physics + vehicle)',
    path: 'training/playgrounds/05-DemoVehicleScene.md',
    url: RAW(AGENT_REPO, 'training/playgrounds/05-DemoVehicleScene.md'),
    keywords: ['vehicle scene', 'vehicle controller', 'car demo', 'vehicle demo'],
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
 * Route a user request to the on-demand blocks it needs.
 * Substring match on a lowercased haystack — cheap, and a false positive only costs cached tokens.
 */
export function selectOnDemandBlocks(requestText: string): OnDemandBlock[] {
  const haystack = requestText.toLowerCase();

  return ON_DEMAND_BLOCKS.filter((block) => block.keywords.some((keyword) => haystack.includes(keyword)));
}
