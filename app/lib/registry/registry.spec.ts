/**
 * Project-creation correctness paths (SPEC §4.4, §4.4a, §4.4b).
 *
 * Everything here fails INVISIBLY in production if it regresses — a missed rename compiles fine and
 * dead-ends at a blank `/play`; a floated dependency range boots fine in dev and only dies at Share.
 * That is what makes them worth tests.
 */
import { describe, expect, it } from 'vitest';
import registryData from '~/config/game-registry.json';
import type { GameRegistryEntry } from '~/types/game-registry';
import { decideSeed, deriveProjectTitle, isVague, rankEntries } from './match';
import { WIZARD_CONFIG, compileWizardPrompt, mechanicsFor, summarizeSelection, validateWizardConfig } from './wizard';
import {
  RESERVED_CLASS_NAMES,
  deriveClassName,
  registerGameModeInGlobals,
  scaffoldGameMode,
  rebaseRelativeImports,
} from './scaffold';
import {
  applyProjectHygiene,
  ensureGitignore,
  isTemplateJunk,
  pinBabylonDependencies,
  removeStrictMode,
} from './hygiene';

const ENTRIES = registryData.entries as GameRegistryEntry[];

/** The real `VehicleControllerDemo.ts` head, verbatim from babylontoolkit/StarterAssets@main. */
const VEHICLE_DEMO = `import { AssetsManager, Quaternion, Scene, TransformNode } from "@babylonjs/core";
import { SceneController, InputController, SceneManager } from "@babylonjs-toolkit/next/scenemanager";
import { StandardCarController, VehicleInputController, VehicleCameraManager } from "@babylonjs-toolkit/next/project";
import GameManager from "../globals";

export class VehicleControllerDemo extends SceneController {

    constructor(transform: TransformNode, scene: Scene, properties: any = {}, alias: string = "VehicleControllerDemo") {
        super(transform, scene, properties, alias);
    }

    protected async createScene(data?: any): Promise<void> {
        const startPosition = this.scene.getNodeByName("StartPosition 20") as TransformNode;
        if (startPosition == null) {
            console.warn("VehicleControllerDemo: 'StartPosition 20' transform not found in scene.");
        }
    }
}

SceneManager.RegisterClass("VehicleControllerDemo", VehicleControllerDemo);
`;

/** The registration block in `src/babylon/globals.ts`, verbatim. */
const GLOBALS = `class GameManager {
    public static async InitializeRuntime(scene: Scene): Promise<void> {
        await import("./classes/DefaultGameMode");
        await import("./classes/FreeCameraMode");
        await import("./classes/PlayerControllerDemo");
        await import("./classes/PlaygroundDemoScene");
        await import("./classes/VehicleControllerDemo");
        if (scene.isDisposed) return;
    }
}
`;

describe('game registry data', () => {
  it('has exactly one fallback entry — Blank Canvas is what a no-match prompt seeds from', () => {
    expect(ENTRIES.filter((entry) => entry.is_fallback)).toHaveLength(1);
  });

  it('only names source classes that exist in the starter library', () => {
    const library = [
      'DefaultGameMode.ts',
      'FreeCameraMode.ts',
      'PlayerControllerDemo.ts',
      'PlaygroundDemoScene.ts',
      'VehicleControllerDemo.ts',
    ];

    for (const entry of ENTRIES) {
      expect(library, entry.id).toContain(entry.source_class);
    }
  });
});

describe('prompt seeding (§4.4a Path A)', () => {
  it('seeds a kart racer from Racing and runs — the acceptance case', () => {
    const decision = decideSeed('make me a kart racer where the cars are shopping carts', ENTRIES);

    expect(decision.kind).toBe('matched');
    expect(decision.kind === 'matched' && decision.entry.id).toBe('gm_racing_v1');
  });

  it.each([
    ['a first person walk through a haunted museum', 'gm_fps_explorer_v1'],
    ['a platformer where a robot jumps around a maze', 'gm_adventure_v1'],
    ['physics sandbox where you smash towers of blocks', 'gm_physics_v1'],
    ['drift racing on a mountain circuit', 'gm_racing_v1'],
  ])('%s → %s', (prompt, expected) => {
    const decision = decideSeed(prompt, ENTRIES);
    expect(decision.kind === 'matched' && decision.entry.id).toBe(expected);
  });

  /*
   * The whole reason keywords are matched as WHOLE WORDS. Substring matching would seed a racing
   * project from the word "cartoon", and the user would watch a car demo boot for no reason.
   */
  it('does not fire on words that merely contain a keyword', () => {
    const decision = decideSeed('a cartoon about tracking parcels', ENTRIES);
    expect(decision.kind).not.toBe('matched');
  });

  it('prefers the entry whose more specific phrase fired', () => {
    const [best] = rankEntries('a first person game', ENTRIES);
    expect(best.entry.id).toBe('gm_fps_explorer_v1');
  });

  /*
   * §4.4a: "Never block on ambiguity when intent is clear." A specific prompt with no genre match
   * must still seed (Blank Canvas) and RUN. Routing it to the wizard would be the bug.
   */
  it('seeds Blank Canvas and runs when a specific prompt matches no genre', () => {
    const decision = decideSeed('a game where you knit sweaters for penguins', ENTRIES);

    expect(decision.kind).toBe('fallback');
    expect(decision.kind === 'fallback' && decision.entry.id).toBe('gm_blank_v1');
  });

  it.each(['I want to make a game', 'help', 'something fun', 'make me something cool', 'idk'])(
    'treats %o as vague — the only automatic route to the wizard',
    (prompt) => {
      expect(isVague(prompt)).toBe(true);
      expect(decideSeed(prompt, ENTRIES).kind).toBe('vague');
    },
  );

  it('does NOT treat a prompt with a discernible subject as vague', () => {
    expect(isVague('a game about a robot in a maze')).toBe(false);
  });

  it('never lets the fallback entry win a keyword match', () => {
    expect(rankEntries('blank canvas empty scene', ENTRIES).some((m) => m.entry.is_fallback)).toBe(false);
  });
});

describe('project title from the prompt (§4.4a — no LLM on the critical path)', () => {
  it.each([
    ['make me a kart racer where the cars are shopping carts', 'Kart Racer'],
    ['build a neon drift racer', 'Neon Drift Racer'],
    ['I want a physics sandbox with ragdolls', 'Physics Sandbox'],
    ['a game about a robot in a maze', 'Robot'],
  ])('%o → %o', (prompt, expected) => {
    expect(deriveProjectTitle(prompt)).toBe(expected);
  });

  it('falls back rather than naming a project after nothing', () => {
    expect(deriveProjectTitle('make me a game', 'Arcade Racing')).toBe('Arcade Racing');
  });

  /* The title becomes the class name, so it has to survive that trip. */
  it('produces a title that yields a legal class name', () => {
    const title = deriveProjectTitle('make me a kart racer where the cars are shopping carts');
    expect(deriveClassName(title, RESERVED_CLASS_NAMES)).toBe('KartRacerMode');
  });
});

describe('guided tour compile (§4.7)', () => {
  const racing = ENTRIES.find((entry) => entry.id === 'gm_racing_v1')!;

  it('has a config that agrees with the registry', () => {
    expect(validateWizardConfig(WIZARD_CONFIG, ENTRIES)).toEqual([]);
  });

  it('offers genre mechanics plus the cross-genre toggles', () => {
    const ids = mechanicsFor('gm_racing_v1').map((mechanic) => mechanic.id);

    expect(ids).toContain('laps');
    expect(ids).toContain('mobile-controls');
  });

  /*
   * Every fragment names the built-in Toolkit system that fulfils it. That is the wizard's entire
   * reliability story: a checkbox steers the model onto a well-trodden path, or it is a liability.
   */
  it('compiles the four steps into a numbered task list', () => {
    const prompt = compileWizardPrompt({
      entry: racing,
      vibeId: 'neon-night',
      mechanicIds: ['laps', 'audio'],
      twist: 'the cars are shopping carts',
    });

    expect(prompt).toContain('neon');
    expect(prompt).toContain('1. Add a lap counter');
    expect(prompt).toContain('2. Add background music');
    expect(prompt).toContain('RacingSystem');
    expect(prompt).toContain('the cars are shopping carts');
  });

  it('summarizes for the user without leaking the compiled prompt', () => {
    const summary = summarizeSelection({
      entry: racing,
      vibeId: 'neon-night',
      mechanicIds: ['laps'],
      twist: 'shopping carts',
    });

    expect(summary).toBe('Arcade Racing · Neon Night · Lap counter & race timer · “shopping carts”');
  });
});

describe('class naming (§4.4b)', () => {
  it.each([
    ['Shopping Cart Racer', 'ShoppingCartRacerMode'],
    ['my racer!', 'MyRacerMode'],
    ['Neon Drift GameMode', 'NeonDriftGameMode'],
    ['3D Test', 'Game3DTestMode'],
  ])('%o → %o', (title, expected) => {
    expect(deriveClassName(title, [])).toBe(expected);
  });

  it('never collides with a class the starter already registers', () => {
    expect(deriveClassName('Default Game', RESERVED_CLASS_NAMES)).toBe('DefaultGameMode2');
  });

  it('numbers collisions within the project', () => {
    expect(deriveClassName('Kart Racer', [...RESERVED_CLASS_NAMES, 'KartRacerMode', 'KartRacerMode2'])).toBe(
      'KartRacerMode3',
    );
  });
});

describe('copy-from-source scaffolding (§4.4b)', () => {
  const scaffolded = scaffoldGameMode({
    sourceClassFile: 'VehicleControllerDemo.ts',
    sourceContent: VEHICLE_DEMO,
    className: 'ShoppingCartRacerMode',
  });

  it('writes the copy into the write zone, named for the class', () => {
    expect(scaffolded.path).toBe('src/scripts/ShoppingCartRacerMode.ts');
  });

  /*
   * The registered STRING is what `navigate('/play', { gameMode })` resolves. A rename that updates
   * the class but not the string produces a project that compiles, boots, and dead-ends at a blank
   * play route — the single most expensive way for this to fail.
   */
  it('renames the class, its RegisterClass string, and the constructor alias together', () => {
    expect(scaffolded.content).toContain('export class ShoppingCartRacerMode extends SceneController');
    expect(scaffolded.content).toContain('SceneManager.RegisterClass("ShoppingCartRacerMode", ShoppingCartRacerMode);');
    expect(scaffolded.content).toContain('alias: string = "ShoppingCartRacerMode"');
  });

  it('leaves no trace of the source class anywhere, including its own log messages', () => {
    expect(scaffolded.content).not.toContain('VehicleControllerDemo');
    expect(scaffolded.content).toContain('console.warn("ShoppingCartRacerMode:');
  });

  /*
   * The copy moves from `src/babylon/classes/` to `src/scripts/`, so `../globals` — which resolved to
   * `src/babylon/globals` — would now resolve to `src/globals`, which does not exist. Vite fails the
   * build outright. This is the bug that makes "copy the file" harder than it looks.
   */
  it('re-bases relative imports for the new directory', () => {
    expect(scaffolded.content).toContain('import GameManager from "../babylon/globals";');
  });

  it('leaves bare package specifiers alone', () => {
    expect(scaffolded.content).toContain('from "@babylonjs/core"');
    expect(scaffolded.content).toContain('from "@babylonjs-toolkit/next/scenemanager"');
  });

  it('re-bases sibling imports too', () => {
    const rebased = rebaseRelativeImports('import x from "./helper";', 'src/babylon/classes', 'src/scripts');
    expect(rebased).toBe('import x from "../babylon/classes/helper";');
  });
});

describe('GameMode registration (§4.4b — the invisible failure)', () => {
  /*
   * Nothing else in the starter imports the class files; `globals.ts` imports each one purely for its
   * `RegisterClass` side effect. A copied class that is not added here NEVER REGISTERS, and the play
   * contract cannot resolve it — a runtime dead end that typecheck and lint both pass.
   */
  it('adds the project GameMode to the registration block', () => {
    const updated = registerGameModeInGlobals(GLOBALS, 'ShoppingCartRacerMode');

    expect(updated).toContain('await import("../scripts/ShoppingCartRacerMode");');
  });

  it('inserts it after the last demo import, still inside InitializeRuntime', () => {
    const lines = registerGameModeInGlobals(GLOBALS, 'ShoppingCartRacerMode').split('\n');
    const inserted = lines.findIndex((line) => line.includes('../scripts/ShoppingCartRacerMode'));
    const lastDemo = lines.findIndex((line) => line.includes('./classes/VehicleControllerDemo'));

    expect(inserted).toBe(lastDemo + 1);
    expect(lines[inserted]).toMatch(/^ {8}await import/);
    expect(lines.slice(inserted).some((line) => line.includes('scene.isDisposed'))).toBe(true);
  });

  it('is idempotent — re-running creation must not stack duplicate imports', () => {
    const once = registerGameModeInGlobals(GLOBALS, 'ShoppingCartRacerMode');
    const twice = registerGameModeInGlobals(once, 'ShoppingCartRacerMode');

    expect(twice).toBe(once);
  });

  it('throws loudly rather than mounting a project whose mode can never register', () => {
    expect(() => registerGameModeInGlobals('class GameManager {}', 'AnyMode')).toThrow(/registration block/i);
  });
});

describe('project hygiene (§4.4)', () => {
  const PACKAGE_JSON = JSON.stringify(
    {
      name: 'my-starter-app',
      dependencies: {
        '@babylonjs-toolkit/next': '^9.15.1',
        '@babylonjs/core': '^9.15.0',
        '@babylonjs/havok': '^1.3.12',
        react: '^19.2.5',
      },
      devDependencies: { vite: '^8.0.10' },
    },
    null,
    2,
  );

  /*
   * The starter ships carets, so `npm install` floats every Babylon package while the toolkit pins
   * its peers exactly. `@babylonjs/serializers` is NOT one of those peers, so it floats to 9.16.1 and
   * imports `__esDecorate` from `@babylonjs/core@9.15.0`'s tslib, which does not export it →
   * MISSING_EXPORT → `npm run build` fails. Dev still boots, so this stays hidden until the user
   * clicks Share (SPEC §4.4, §4.8).
   *
   * The starter's committed lockfile does NOT fix this — it was taken after the caret had already
   * floated, so it pins the broken pair deterministically (verified: `npm ci && npm run build` on a
   * clean clone fails; pinning + dropping the lockfile builds clean). Hence both halves below.
   */
  it('pins every Babylon package to an exact version', () => {
    const pinned = JSON.parse(pinBabylonDependencies(PACKAGE_JSON));

    expect(pinned.dependencies['@babylonjs/core']).toBe('9.15.0');
    expect(pinned.dependencies['@babylonjs/havok']).toBe('1.3.12');
    expect(pinned.dependencies['@babylonjs-toolkit/next']).toBe('9.15.1');
  });

  it('leaves non-Babylon ranges alone — only the toolkit peer set is version-locked', () => {
    const pinned = JSON.parse(pinBabylonDependencies(PACKAGE_JSON));

    expect(pinned.dependencies.react).toBe('^19.2.5');
    expect(pinned.devDependencies.vite).toBe('^8.0.10');
  });

  it('names the package after the project', () => {
    const pinned = JSON.parse(pinBabylonDependencies(PACKAGE_JSON, 'shopping-cart-racer'));
    expect(pinned.name).toBe('shopping-cart-racer');
  });

  it('guarantees node_modules and .env are ignored', () => {
    expect(ensureGitignore('dist')).toContain('node_modules');
    expect(ensureGitignore('dist')).toContain('.env');
    expect(ensureGitignore('node_modules/\n.env\n')).toBe('node_modules/\n.env\n');
  });

  it('removes StrictMode, which double-initializes the Babylon window', () => {
    const main = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`;
    const cleaned = removeStrictMode(main);

    expect(cleaned).not.toContain('StrictMode');
    expect(cleaned).toContain('<App />');
  });

  it.each(['.git/config', 'node_modules/react/index.js', 'Screenshot.png', 'tsconfig.app.tsbuildinfo', '.gitmodules'])(
    'never mounts %s',
    (path) => {
      expect(isTemplateJunk(path)).toBe(true);
    },
  );

  /*
   * The lockfile is the project's exact, tested dependency resolution — SPEC §4.4 requires it to ship,
   * and it makes the container's `npm install` deterministic and fast. But at ~218KB (~55k tokens) it
   * must never be inlined into the artifact, which reaches the MODEL. It goes to disk out-of-band,
   * exactly as binaries do. These two assertions are the whole contract, and they pull in opposite
   * directions — hence both.
   */
  it('keeps the lockfile in the project (it is not junk)', () => {
    expect(isTemplateJunk('package-lock.json')).toBe(false);
  });

  /*
   * Upstream now pins the Babylon set exactly (9.16.0 + an `overrides` block for the transitive
   * gui-editor), so pinning is a NO-OP on the current starter and must stay that way — a pin that
   * REWROTE a correct version would fight the committed lockfile.
   */
  it('leaves an already-pinned dependency set untouched', () => {
    const pinned = JSON.stringify(
      { name: 'my-starter-app', dependencies: { '@babylonjs/core': '9.16.0', '@babylonjs/serializers': '9.16.0' } },
      null,
      2,
    );

    const out = JSON.parse(pinBabylonDependencies(pinned));

    expect(out.dependencies['@babylonjs/core']).toBe('9.16.0');
    expect(out.dependencies['@babylonjs/serializers']).toBe('9.16.0');
  });

  it.each(['src/main.tsx', 'package.json', 'public/babylon.png', 'src/babylon/globals.ts'])('mounts %s', (path) => {
    expect(isTemplateJunk(path)).toBe(false);
  });

  it('leaves binary files byte-identical — hygiene is a TEXT transform', () => {
    const png = { name: 'hero.png', path: 'src/assets/hero.png', content: 'iVBORw0KGgo=', isBinary: true };
    const [out] = applyProjectHygiene([png]);

    expect(out).toEqual(png);
  });
});
