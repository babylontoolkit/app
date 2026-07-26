import ignore from 'ignore';
import type { ProviderInfo } from '~/types/model';
import type { Template } from '~/types/template';
import { STARTER_TEMPLATES } from './constants';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { sandbox } from '~/lib/sandbox';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('StarterTemplate');

const starterTemplateSelectionPrompt = (templates: Template[]) => `
You are an experienced developer who helps people choose the best starter template for their projects.
IMPORTANT: Vite is preferred
IMPORTANT: Only choose shadcn templates if the user explicitly asks for shadcn.

Available templates:
<template>
  <name>blank</name>
  <description>Empty starter for simple scripts and trivial tasks that don't require a full template setup</description>
  <tags>basic, script</tags>
</template>
${templates
  .map(
    (template) => `
<template>
  <name>${template.name}</name>
  <description>${template.description}</description>
  ${template.tags ? `<tags>${template.tags.join(', ')}</tags>` : ''}
</template>
`,
  )
  .join('\n')}

Response Format:
<selection>
  <templateName>{selected template name}</templateName>
  <title>{a proper title for the project}</title>
</selection>

Examples:

<example>
User: I need to build a todo app
Response:
<selection>
  <templateName>react-basic-starter</templateName>
  <title>Simple React todo application</title>
</selection>
</example>

<example>
User: Write a script to generate numbers from 1 to 100
Response:
<selection>
  <templateName>blank</templateName>
  <title>script to generate numbers from 1 to 100</title>
</selection>
</example>

Instructions:
1. For trivial tasks and simple scripts, always recommend the blank template
2. For more complex projects, recommend templates from the provided list
3. Follow the exact XML format
4. Consider both technical requirements and tags
5. If no perfect match exists, recommend the closest option

Important: Provide only the selection tags in your response, no additional text.
MOST IMPORTANT: YOU DONT HAVE TIME TO THINK JUST START RESPONDING BASED ON HUNCH 
`;

const templates: Template[] = STARTER_TEMPLATES.filter((t) => !t.name.includes('shadcn'));

const parseSelectedTemplate = (llmOutput: string): { template: string; title: string } | null => {
  try {
    // Extract content between <templateName> tags
    const templateNameMatch = llmOutput.match(/<templateName>(.*?)<\/templateName>/);
    const titleMatch = llmOutput.match(/<title>(.*?)<\/title>/);

    if (!templateNameMatch) {
      return null;
    }

    return { template: templateNameMatch[1].trim(), title: titleMatch?.[1].trim() || 'Untitled Project' };
  } catch (error) {
    console.error('Error parsing template selection:', error);
    return null;
  }
};

export const selectStarterTemplate = async (options: { message: string; model: string; provider: ProviderInfo }) => {
  const { message, model, provider } = options;
  const requestBody = {
    message,
    model,
    provider,
    system: starterTemplateSelectionPrompt(templates),
  };
  const response = await fetch('/api/llmcall', {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  const respJson: { text: string } = await response.json();
  console.log(respJson);

  const { text } = respJson;
  const selectedTemplate = parseSelectedTemplate(text);

  if (selectedTemplate) {
    return selectedTemplate;
  } else {
    console.log('No template selected, using blank template');

    return {
      template: 'blank',
      title: '',
    };
  }
};

interface TemplateFile {
  name: string;
  path: string;

  /** base64 when `isBinary`, UTF-8 text otherwise. */
  content: string;
  isBinary?: boolean;
}

const getGitHubRepoContent = async (repoName: string): Promise<TemplateFile[]> => {
  try {
    // Instead of directly fetching from GitHub, use our own API endpoint as a proxy
    const response = await fetch(`/api/github-template?repo=${encodeURIComponent(repoName)}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Our API will return the files in the format we need
    const files = (await response.json()) as any;

    return files;
  } catch (error) {
    console.error('Error fetching release contents:', error);
    throw error;
  }
};

/**
 * Write template binaries into the WebContainer as real bytes.
 *
 * Missing assets are reported loudly rather than swallowed: a template that mounts without
 * its images produces an unresolvable Vite import and a blank preview, which is exactly the
 * failure this whole path exists to prevent.
 */
async function writeBinaryTemplateFiles(files: TemplateFile[]) {
  const container = await sandbox;

  for (const file of files) {
    try {
      const dir = file.path.split('/').slice(0, -1).join('/');

      if (dir) {
        await container.fs.mkdir(dir, { recursive: true });
      }

      await container.fs.writeFile(file.path, base64ToBytes(file.content));
    } catch (error) {
      logger.error(`Failed to write binary template file: ${file.path}`, error);
      throw new Error(`Failed to mount template asset "${file.path}" — the project would be missing assets.`);
    }
  }

  logger.info(`Mounted ${files.length} binary template asset(s)`);

  await ensureFrameworkPublicAssets(files);
}

/**
 * Project-setup hygiene mandated by `project-installer.md` / `react-framework.md`
 * (SPEC §4.4): the framework preloader expects `babylon.png` and `spinner.png` to exist in
 * `public/`. They ship in the framework's own assets folder, so copy them across if the
 * template did not already provide them.
 *
 * Best-effort by design: a template that carries neither is not broken by this step.
 */
async function ensureFrameworkPublicAssets(files: TemplateFile[]) {
  const container = await sandbox;

  for (const name of ['babylon.png', 'spinner.png']) {
    const target = `public/${name}`;

    if (files.some((f) => f.path === target)) {
      continue;
    }

    /*
     * `src/babylon/assets/` is the framework's own copy and the source SPEC §4.4 names.
     * Fall back to any other assets folder so non-standard templates still work.
     */
    const source =
      files.find((f) => f.isBinary && f.path === `src/babylon/assets/${name}`) ??
      files.find((f) => f.isBinary && f.path.endsWith(`/assets/${name}`));

    if (!source) {
      logger.warn(`Framework asset ${name} not found in template — skipping public/ copy`);
      continue;
    }

    try {
      await container.fs.mkdir('public', { recursive: true });
      await container.fs.writeFile(target, base64ToBytes(source.content));
      logger.info(`Copied ${source.path} -> ${target}`);
    } catch (error) {
      logger.error(`Failed to copy framework asset to ${target}`, error);
    }
  }
}

export async function getTemplates(templateName: string, title?: string) {
  const template = STARTER_TEMPLATES.find((t) => t.name == templateName);

  if (!template) {
    return null;
  }

  const githubRepo = template.githubRepo;
  const files = await getGitHubRepoContent(githubRepo);

  let filteredFiles = files;

  /*
   * ignoring common unwanted files
   * exclude    .git
   */
  filteredFiles = filteredFiles.filter((x) => x.path.startsWith('.git') == false);

  /*
   * exclude    lock files
   * WE NOW INCLUDE LOCK FILES FOR IMPROVED INSTALL TIMES
   */
  {
    /*
     *const comminLockFiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
     *filteredFiles = filteredFiles.filter((x) => comminLockFiles.includes(x.name) == false);
     */
  }

  // exclude    .bolt
  filteredFiles = filteredFiles.filter((x) => x.path.startsWith('.bolt') == false);

  // check for ignore file in .bolt folder
  const templateIgnoreFile = files.find((x) => x.path.startsWith('.bolt') && x.name == 'ignore');

  const filesToImport = {
    files: filteredFiles,
    ignoreFile: [] as typeof filteredFiles,
  };

  if (templateIgnoreFile) {
    // redacting files specified in ignore file
    const ignorepatterns = templateIgnoreFile.content.split('\n').map((x) => x.trim());
    const ig = ignore().add(ignorepatterns);

    // filteredFiles = filteredFiles.filter(x => !ig.ignores(x.path))
    const ignoredFiles = filteredFiles.filter((x) => ig.ignores(x.path));

    filesToImport.files = filteredFiles;
    filesToImport.ignoreFile = ignoredFiles;
  }

  /**
   * Binary template assets (textures, models, audio, fonts, wasm) are written straight into
   * the WebContainer as bytes and are NEVER routed through the boltArtifact.
   *
   * The artifact is a TEXT protocol: the action runner UTF-8 encodes whatever it is given,
   * so a PNG round-tripped through it arrives corrupted — and its base64 would also land in
   * LLM context, which SPEC §1.3 principle 10 forbids. The framework requires
   * `public/babylon.png` and `public/spinner.png` to exist on disk; this is what puts them
   * there (SPEC §4.4).
   */
  const binaryFiles = filesToImport.files.filter((file) => file.isBinary);
  const textFiles = filesToImport.files.filter((file) => !file.isBinary);

  if (binaryFiles.length > 0) {
    await writeBinaryTemplateFiles(binaryFiles);
  }

  const assistantMessage = `
Bolt is initializing your project with the required files using the ${template.name} template.
<boltArtifact id="imported-files" title="${title || 'Create initial files'}" type="bundled">
${textFiles
  .map(
    (file) =>
      `<boltAction type="file" filePath="${file.path}">
${file.content}
</boltAction>`,
  )
  .join('\n')}
</boltArtifact>
`;
  let userMessage = ``;
  const templatePromptFile = files.filter((x) => x.path.startsWith('.bolt')).find((x) => x.name == 'prompt');

  if (templatePromptFile) {
    userMessage = `
TEMPLATE INSTRUCTIONS:
${templatePromptFile.content}

---
`;
  }

  if (filesToImport.ignoreFile.length > 0) {
    userMessage =
      userMessage +
      `
STRICT FILE ACCESS RULES - READ CAREFULLY:

The following files are READ-ONLY and must never be modified:
${filesToImport.ignoreFile.map((file) => `- ${file.path}`).join('\n')}

Permitted actions:
✓ Import these files as dependencies
✓ Read from these files
✓ Reference these files

Strictly forbidden actions:
❌ Modify any content within these files
❌ Delete these files
❌ Rename these files
❌ Move these files
❌ Create new versions of these files
❌ Suggest changes to these files

Any attempt to modify these protected files will result in immediate termination of the operation.

If you need to make changes to functionality, create new files instead of modifying the protected ones listed above.
---
`;
  }

  userMessage += `
---
template import is done, and you can now use the imported files,
edit only the files that need to be changed, and you can create new files as needed.
NO NOT EDIT/WRITE ANY FILES THAT ALREADY EXIST IN THE PROJECT AND DOES NOT NEED TO BE MODIFIED
---
Now that the Template is imported please continue with my original request

IMPORTANT: Dont Forget to install the dependencies before running the app by using \`npm install && npm run dev\`
`;

  return {
    assistantMessage,
    userMessage,
  };
}
