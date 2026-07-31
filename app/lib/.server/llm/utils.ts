import { type Message } from 'ai';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODEL_REGEX, PROVIDER_REGEX } from '~/utils/constants';
import { IGNORE_PATTERNS, type FileMap } from './constants';
import ignore from 'ignore';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import type { ContextAnnotation } from '~/types/context';
import { isOpaqueToModel } from '~/lib/context/opaque-files';

export function extractPropertiesFromMessage(message: Omit<Message, 'id'>): {
  model: string;
  provider: string;
  content: string;
} {
  const textContent = Array.isArray(message.content)
    ? message.content.find((item) => item.type === 'text')?.text || ''
    : message.content;

  const modelMatch = textContent.match(MODEL_REGEX);
  const providerMatch = textContent.match(PROVIDER_REGEX);

  /*
   * Extract model
   * const modelMatch = message.content.match(MODEL_REGEX);
   */
  const model = modelMatch ? modelMatch[1] : DEFAULT_MODEL;

  /*
   * Extract provider
   * const providerMatch = message.content.match(PROVIDER_REGEX);
   */
  const provider = providerMatch ? providerMatch[1] : DEFAULT_PROVIDER.name;

  const cleanedContent = Array.isArray(message.content)
    ? message.content.map((item) => {
        if (item.type === 'text') {
          return {
            type: 'text',
            text: item.text?.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, ''),
          };
        }

        return item; // Preserve image_url and other types as is
      })
    : textContent.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '');

  return { model, provider, content: cleanedContent };
}

export function simplifyBoltActions(input: string): string {
  // Using regex to match boltAction tags that have type="file"
  const regex = /(<boltAction[^>]*type="file"[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

  // Replace each matching occurrence
  return input.replace(regex, (_0, openingTag, _2, closingTag) => {
    return `${openingTag}\n          ...\n        ${closingTag}`;
  });
}

export function createFilesContext(files: FileMap, useRelativePath?: boolean) {
  const ig = ignore().add(IGNORE_PATTERNS);

  /*
   * 🔴 SORTED, because this block is CACHED and `Object.keys` order is watcher-arrival order
   * (found 2026-07-30). The map's key order is whatever sequence the client's file watcher happened
   * to discover files in — which differs between a fresh mount, a reload, and a device switch. Same
   * project, same bytes, different ORDER → a different prefix → the whole file-context cache entry
   * rewritten at 2×, for content that did not change. Nothing throws; the bill just goes up.
   * `.sort()` (code-unit order — never `localeCompare`, which is locale-dependent) makes the bytes a
   * pure function of the map's CONTENT.
   */
  let filePaths = Object.keys(files).sort();
  filePaths = filePaths.filter((x) => {
    const relPath = toProjectRelativePath(x);
    return !ig.ignores(relPath);
  });

  const fileContexts = filePaths
    .filter((x) => files[x] && files[x].type == 'file')
    .map((path) => {
      const dirent = files[path];

      if (!dirent || dirent.type == 'folder') {
        return '';
      }

      /**
       * Binary content never enters LLM context (SPEC §1.3 principle 10). Emitting a
       * binary here would ship an EMPTY <boltAction type="file"> for it — inviting the
       * model to "helpfully" rewrite a texture or model as an empty text file. The agent
       * is told the file exists and how big it is, and nothing more.
       */
      if (dirent.isBinary) {
        return `<boltFile filePath="${useRelativePath ? toProjectRelativePath(path) : path}" binary="true" size="${dirent.size ?? 0}" />`;
      }

      /**
       * Opaque files are text, but no correct edit to them exists: vendor runtime shims, image
       * assets, the lockfile (SPEC §4.2.8). They get the same treatment as binaries — the model is
       * told they exist and how big they are, and nothing more. `public/scripts/` alone is HALF the
       * starter's text payload, and it was being re-sent, at full price, on every step.
       */
      const relativePath = toProjectRelativePath(path);

      if (isOpaqueToModel(relativePath)) {
        return `<boltFile filePath="${useRelativePath ? relativePath : path}" opaque="true" size="${dirent.content.length}" />`;
      }

      const codeWithLinesNumbers = dirent.content
        .split('\n')
        // .map((v, i) => `${i + 1}|${v}`)
        .join('\n');

      let filePath = path;

      if (useRelativePath) {
        filePath = toProjectRelativePath(path);
      }

      return `<boltAction type="file" filePath="${filePath}">${codeWithLinesNumbers}</boltAction>`;
    });

  return `<boltArtifact id="code-content" title="Code Content" >\n${fileContexts.join('\n')}\n</boltArtifact>`;
}

export function extractCurrentContext(messages: Message[]) {
  const lastAssistantMessage = messages.filter((x) => x.role == 'assistant').slice(-1)[0];

  if (!lastAssistantMessage) {
    return { summary: undefined, codeContext: undefined };
  }

  let summary: ContextAnnotation | undefined;
  let codeContext: ContextAnnotation | undefined;

  if (!lastAssistantMessage.annotations?.length) {
    return { summary: undefined, codeContext: undefined };
  }

  for (let i = 0; i < lastAssistantMessage.annotations.length; i++) {
    const annotation = lastAssistantMessage.annotations[i];

    if (!annotation || typeof annotation !== 'object') {
      continue;
    }

    if (!(annotation as any).type) {
      continue;
    }

    const annotationObject = annotation as any;

    if (annotationObject.type === 'codeContext') {
      codeContext = annotationObject;
      break;
    } else if (annotationObject.type === 'chatSummary') {
      summary = annotationObject;
      break;
    }
  }

  return { summary, codeContext };
}
