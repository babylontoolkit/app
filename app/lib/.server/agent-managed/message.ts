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
 *     (D5) — so the agent knows the project's shape before its first `project_list`;
 *   - the first message of a new session in a chat that ALREADY has turns (the user changed model tier, so
 *     the chat moved to that tier's agent; or the old session died) carries a recap of the conversation
 *     so far — the words only, capped, newest kept (`conversationRecap`). The new session has no memory
 *     of the old one, and without it "make the jump higher" arrives with no idea what game this is;
 *   - a FIRST BUILD (T9) appends the phase list (design → game → front end) as guidance after the
 *     user's words: the whole build is one managed turn, not three requests.
 */
import type {
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsUserMessageEventParams,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { Message } from 'ai';
import { buildRepairMessage } from '~/lib/.server/agent/proxy';
import type { FileMap } from '~/lib/.server/llm/constants';
import { managedBuildGuidance, type CreationPhaseId } from '~/lib/agent/creation-plan';
import { splitCarriedArtifact, stripTransportPrefix, userTypedText } from '~/lib/chat/message-envelope';
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

/** The recap's ceiling (chars). The files are read fresh with the tools — this is the conversation only. */
export const RECAP_MAX_CHARS = 12_000;

/** One message's ceiling inside the recap, so one long reply cannot crowd out the rest. */
export const RECAP_MESSAGE_MAX_CHARS = 1_500;

/** Assistant text without file bodies: artifact/action blocks are what the files are, not what was said. */
function spokenText(text: string): string {
  return text
    .replace(/<boltArtifact[\s\S]*?<\/boltArtifact>/g, '')
    .replace(/<boltAction[\s\S]*?<\/boltAction>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The conversation BEFORE the message this turn sends, as plain lines — for the first message of a new
 * session in a chat that already has turns. Empty when there is nothing earlier. Newest turns are kept
 * when the cap bites (they are the ones the next request is most likely about), and the cut is SAID.
 */
export function conversationRecap(messages: Message[]): string {
  let lastUserIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const earlier = (lastUserIndex === -1 ? messages : messages.slice(0, lastUserIndex)).filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );

  const lines: string[] = [];

  for (const message of earlier) {
    const raw = messageText(message);
    const said = message.role === 'user' ? userTypedText(raw).trim() : spokenText(raw);

    if (!said) {
      continue;
    }

    const clipped = said.length > RECAP_MESSAGE_MAX_CHARS ? `${said.slice(0, RECAP_MESSAGE_MAX_CHARS)}…` : said;
    lines.push(`${message.role === 'user' ? 'User' : 'You'}: ${clipped}`);
  }

  if (lines.length === 0) {
    return '';
  }

  const kept: string[] = [];
  let size = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > RECAP_MAX_CHARS && kept.length > 0) {
      break;
    }

    kept.unshift(lines[i]);
    size += lines[i].length;
  }

  const cut = kept.length < lines.length ? `(${lines.length - kept.length} earlier message(s) omitted)\n` : '';

  return (
    '[Conversation so far — this chat continues on a new session, so here is what was said before. ' +
    'The project files are current; read them with the tools rather than trusting this recap for code.]\n' +
    `${cut}${kept.join('\n\n')}\n[End of conversation so far]\n\n`
  );
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

  /**
   * A FIRST BUILD (T9): the phases this one turn owes, appended after the user's words as guidance
   * (`managedBuildGuidance`). Absent or empty on every other turn. Never on a repair — a repair is about
   * its errors, and the build it repairs already ran.
   */
  buildPhases?: readonly CreationPhaseId[];
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

  const manifest = input.newSession ? `${projectManifest(input.files)}${conversationRecap(input.messages)}` : '';
  const guidance = input.errors?.length ? '' : managedBuildGuidance(input.buildPhases ?? []);
  const words = body || '(see the attached image)';
  const text: BetaManagedAgentsTextBlock = {
    type: 'text',
    text: `${manifest}${words}${guidance ? `\n\n${guidance}` : ''}`,
  };

  return { type: 'user.message', content: [text, ...images] };
}
