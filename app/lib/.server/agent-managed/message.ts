/**
 * The `user.message` a managed turn sends (`_specs/managed-agents-engine_plan.md` D5, T5). Pure.
 *
 * The session holds the conversation, so a turn sends ONE message — never the history, never file
 * bodies:
 *
 *   - an ordinary turn sends what the user typed (the transport envelope stripped; the client's
 *     carried modified-files artifact kept, exactly as the legacy engine keeps it), plus any image
 *     attachments as image blocks;
 *   - a repair turn (`errors`) sends the build errors (`buildRepairMessage`, the legacy wording);
 *   - the FIRST message of a new session is prefixed with the project manifest — sorted paths only
 *     (D5) — so the agent knows the project's shape before its first `project_list`.
 */
import type {
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsUserMessageEventParams,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { Message } from 'ai';
import { buildRepairMessage } from '~/lib/.server/agent/proxy';
import type { FileMap } from '~/lib/.server/llm/constants';
import { splitCarriedArtifact, stripTransportPrefix } from '~/lib/chat/message-envelope';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';

/** The manifest's ceiling — a starter is ~80 files; a project with thousands is listed in part. */
export const MANIFEST_MAX_PATHS = 800;

const SKIPPED = ['node_modules/', '.git/', 'dist/', '.codesandbox/'];

export function projectManifest(files: FileMap | undefined): string {
  const paths = Object.entries(files ?? {})
    .filter(([, dirent]) => dirent?.type === 'file')
    .map(([key]) => toProjectRelativePath(key))
    .filter((p) => p && !SKIPPED.some((dir) => p.startsWith(dir) || p.includes(`/${dir}`)))
    .sort();

  if (paths.length === 0) {
    return '';
  }

  const shown = paths.slice(0, MANIFEST_MAX_PATHS);
  const more = paths.length > shown.length ? `\n…and ${paths.length - shown.length} more (use project_list)` : '';

  return (
    `[Project files — paths only; read them with project_read]\n${shown.join('\n')}${more}\n` +
    '[End of project files]\n\n'
  );
}

function messageText(message: Message | undefined): string {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string' && message.content) {
    return message.content;
  }

  const parts = ((message as { parts?: unknown }).parts ?? []) as Array<{ type?: string; text?: string }>;

  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

function imageBlocks(message: Message | undefined): BetaManagedAgentsImageBlock[] {
  const attachments =
    (message as (Message & { experimental_attachments?: Array<{ contentType?: string; url?: string }> }) | undefined)
      ?.experimental_attachments ?? [];

  const blocks: BetaManagedAgentsImageBlock[] = [];

  for (const attachment of attachments) {
    const match = typeof attachment?.url === 'string' ? DATA_URL.exec(attachment.url) : null;
    const mediaType = attachment?.contentType || match?.[1] || '';

    if (match && mediaType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] } });
    }
  }

  return blocks;
}

export interface ManagedMessageInput {
  messages: Message[];
  errors?: string[];
  files?: FileMap;

  /** The session was created by this turn — prefix the manifest. */
  newSession: boolean;
}

/** The turn's `user.message`, or `null` when there is nothing to send (no user text, no errors). */
export function buildManagedUserMessage(input: ManagedMessageInput): BetaManagedAgentsUserMessageEventParams | null {
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');

  let body: string;
  let images: BetaManagedAgentsImageBlock[] = [];

  if (input.errors?.length) {
    body = buildRepairMessage(input.errors);
  } else {
    const { carried, text } = splitCarriedArtifact(stripTransportPrefix(messageText(lastUser)));
    body = `${carried}${text}`.trim();
    images = imageBlocks(lastUser);
  }

  if (!body && images.length === 0) {
    return null;
  }

  const manifest = input.newSession ? projectManifest(input.files) : '';
  const text: BetaManagedAgentsTextBlock = { type: 'text', text: `${manifest}${body || '(see the attached image)'}` };

  return { type: 'user.message', content: [text, ...images] };
}
