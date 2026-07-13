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
  {
    id: 'project-installer',
    path: 'references/project-installer.md',
    url: RAW(AGENT_REPO, 'references/project-installer.md'),
  },

  /*
   * PLATFORM DETECTION (SPEC §4.3): `project-installer.md` runs a BLOCKING platform-detection
   * procedure that maps each host (Lovable / Replit / Bolt.new / Base44 / V0 / Generic) to a
   * reference doc. We are a distinct host platform, but `references/web-app-babylon-builder.md`
   * does not exist in the agent repo yet (owner action). Until it does we bake GENERIC, exactly as
   * the spec directs. When the babylon-builder doc lands, swap this entry and resync.
   */
  { id: 'platform-host', path: 'references/web-app-generic.md', url: RAW(AGENT_REPO, 'references/web-app-generic.md') },

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
 */
export const ON_DEMAND_BLOCKS: OnDemandBlock[] = [
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
