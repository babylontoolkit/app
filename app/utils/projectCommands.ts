import type { Message } from 'ai';
import { generateId } from './fileUtils';
import { decideRolldownWasm } from './rolldown-wasm';

export interface ProjectCommands {
  type: string;
  setupCommand?: string;
  startCommand?: string;
  followupMessage: string;
}

interface FileContent {
  content: string;
  path: string;
}

/**
 * 🔴 EVERY COMMAND THIS MODULE EMITS MUST PASS `isAllowedShellCommand` — OR IT NEVER RUNS.
 *
 * Upstream built the setup command with a `makeNonInteractive()` helper that prefixed
 * `export CI=true DEBIAN_FRONTEND=noninteractive FORCE_COLOR=0 &&`, chained
 * `npx update-browserslist-db@latest`, and appended `npx shadcn@latest init` for shadcn projects.
 * Sensible in bolt.diy, which runs whatever the model emits. In this fork the shell allow-list
 * (SPEC §4.2.5, §5) permits exactly `npm install …` and `npm run <script>`, and `isAllowedShellCommand`
 * refuses a chain unless EVERY `&&` segment passes — so the first segment, `export`, killed the whole
 * command. **Every repository import in this fork ran zero `npm install`s.**
 *
 * It failed in the worst possible shape: the install action was refused, the `start` action was not
 * (`npm run dev` is allow-listed), so the dev server launched into an empty `node_modules`, Vite exited
 * immediately, and the user got a terminal showing `> vite` and a fresh prompt with **no preview and no
 * stated cause**. Reported as "it looks like the npm install DID NOT RUN. The terminal does not look
 * right" — which was exactly correct.
 *
 * So the commands are now written to be allow-list-legal BY CONSTRUCTION, and
 * `projectCommands.spec.ts` runs the real `isAllowedShellCommand` over everything this module can
 * produce. Adding a flag or a chained tool here without checking that gate reintroduces a silent,
 * total failure of every import path.
 *
 * What was dropped and why it costs nothing:
 *   • the `export …` env prefix — WebContainer/Nodepod shells are already non-interactive;
 *   • `npx update-browserslist-db@latest` — a caniuse data refresh, never required to boot a project;
 *   • `npx shadcn@latest init` — scaffolding that would clobber an imported repo's own config anyway.
 *
 * `--no-audit --no-fund` stay: both are plain `npm install` flags the allow-list accepts, and they cut
 * a lot of noise from the terminal. `--silent` is deliberately NOT used — this output is the user's
 * only window into a slow or failing install.
 */
const SETUP_COMMAND = 'npm install --no-audit --no-fund';

/**
 * What the detector needs to know about the runtime it is writing commands for.
 *
 * REQUIRED rather than defaulted, following `restore-plan.ts`'s `protect`: a default here would be
 * a silent answer to a question only the call site can answer, and both wrong answers cost
 * something real (a lost preview, or a ~10MB download nobody uses). Making it required means a new
 * import path cannot forget it — TypeScript asks.
 */
export interface DetectOptions {
  /** `SandboxProvider.capabilities.nativeAddons` — can this runtime load a compiled `.node`? */
  nativeAddons: boolean;
}

export async function detectProjectCommands(files: FileContent[], options: DetectOptions): Promise<ProjectCommands> {
  const hasFile = (name: string) => files.some((f) => f.path.endsWith(name));

  /*
   * A browser-hosted runtime cannot load rolldown's native binding, so a Vite 8 project installs and
   * starts and then dies with `Cannot find native binding` and no preview. Chained onto the install
   * with `&&` rather than emitted as a third action: `ProjectCommands` carries exactly two commands
   * and both message builders render exactly those two, so a third field would have to be threaded
   * through every one of them — and `&&` makes the ordering a property of the command instead of a
   * property of the queue that runs it. Both segments are allow-list legal (`rolldown-wasm.ts`).
   */
  const rolldown = decideRolldownWasm(files, options);
  const setupCommand = rolldown.install ? `${SETUP_COMMAND} && ${rolldown.install}` : SETUP_COMMAND;
  const withNote = (message: string) => (rolldown.note ? `${message}\n\n${rolldown.note}` : message);

  if (hasFile('package.json')) {
    const packageJsonFile = files.find((f) => f.path.endsWith('package.json'));

    if (!packageJsonFile) {
      return { type: '', setupCommand: '', followupMessage: '' };
    }

    try {
      const packageJson = JSON.parse(packageJsonFile.content);
      const scripts = packageJson?.scripts || {};

      // Check for preferred commands in priority order
      const preferredCommands = ['dev', 'start', 'preview'];
      const availableCommand = preferredCommands.find((cmd) => scripts[cmd]);

      if (availableCommand) {
        return {
          type: 'Node.js',
          setupCommand,
          startCommand: `npm run ${availableCommand}`,
          followupMessage: withNote(
            `Found "${availableCommand}" script in package.json. Running "npm run ${availableCommand}" after installation.`,
          ),
        };
      }

      return {
        type: 'Node.js',
        setupCommand,
        followupMessage: withNote(
          'Would you like me to inspect package.json to determine the available scripts for running this project?',
        ),
      };
    } catch (error) {
      console.error('Error parsing package.json:', error);
      return { type: '', setupCommand: '', followupMessage: '' };
    }
  }

  if (hasFile('index.html')) {
    /*
     * A static site with no `package.json`. Upstream started it with `npx --yes serve`, which the
     * allow-list refuses (`npx` is not `npm`) — so it emitted an action guaranteed to fail and the
     * user was told nothing useful. Say what is true instead: the files are here, and there is no
     * command we are permitted to run to serve them. A refusal that names its cause beats a red
     * action row with a shell error in it (`share/build-failure.ts`, same lesson one door over).
     */
    return {
      type: 'Static',
      followupMessage:
        'This looks like a static site with no `package.json`. Add one with a `dev` script (for example ' +
        'using Vite) and I can install and run it — only `npm install` and `npm run <script>` may be ' +
        'run in your workspace.',
    };
  }

  return { type: '', setupCommand: '', followupMessage: '' };
}

export function createCommandsMessage(commands: ProjectCommands): Message | null {
  if (!commands.setupCommand && !commands.startCommand) {
    return null;
  }

  let commandString = '';

  if (commands.setupCommand) {
    commandString += `
<boltAction type="shell">${commands.setupCommand}</boltAction>`;
  }

  if (commands.startCommand) {
    commandString += `
<boltAction type="start">${commands.startCommand}</boltAction>
`;
  }

  return {
    role: 'assistant',
    content: `
${commands.followupMessage ? `\n\n${commands.followupMessage}` : ''}
<boltArtifact id="project-setup" title="Project Setup">
${commandString}
</boltArtifact>`,
    id: generateId(),
    createdAt: new Date(),
  };
}

export function escapeBoltArtifactTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltArtifact[^>]*>)([\s\S]*?)(<\/boltArtifact>)/g;

  return input.replace(regex, (match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltAActionTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltAction[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

  return input.replace(regex, (match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltTags(input: string) {
  return escapeBoltArtifactTags(escapeBoltAActionTags(input));
}

// We have this seperate function to simplify the restore snapshot process in to one single artifact.
export function createCommandActionsString(commands: ProjectCommands): string {
  if (!commands.setupCommand && !commands.startCommand) {
    // Return empty string if no commands
    return '';
  }

  let commandString = '';

  if (commands.setupCommand) {
    commandString += `
<boltAction type="shell">${commands.setupCommand}</boltAction>`;
  }

  if (commands.startCommand) {
    commandString += `
<boltAction type="start">${commands.startCommand}</boltAction>
`;
  }

  return commandString;
}
