/**
 * What a user message actually SAYS — the one string both the bubble and its Copy button use.
 *
 * ## Why this is a module and not two lines in the component
 *
 * 🔴 **A user message on the wire is not what the user typed.** Three things ride along with it, none
 * of them visible in the chat:
 *
 *   - a machine-generated `<boltArtifact>` of every file the user edited in the workbench, prepended by
 *     the client to the next message (`spec/context-budget.md` — it is why `compactContent` has to run
 *     over USER messages too);
 *   - `[Model: …]` / `[Provider: …]` tags, from upstream's BYOK path.
 *
 * The bubble has always stripped those before rendering. The Copy button (owner, 2026-08-09) makes the
 * distinction load-bearing in a new way: copying the RAW content would put tens of kilobytes of file
 * bodies on the clipboard from a message that reads as one line on screen — silently, and the user
 * would only find out when they pasted it somewhere. **Copy copies what is displayed**, which is only
 * guaranteed while one function answers both questions.
 *
 * Pure, so the stripping is testable without React — the component that owned it is `@ts-nocheck`
 * upstream code, and a rule about what leaves the app in a clipboard deserves better than that.
 */
import { MODEL_REGEX, PROVIDER_REGEX } from '~/utils/constants';

/** The shape the AI SDK hands us: a plain string, or the multimodal parts array. */
export type UserMessageContent = string | Array<{ type: string; text?: string; image?: string }>;

/**
 * A `<boltArtifact>` block and everything inside it.
 *
 * Deliberately NOT anchored: the client prepends this to the front of the user's text, but a message
 * the user sent from the middle of an edit can carry it anywhere, and a stray block left in the middle
 * of the string is exactly the "why is there half a file in my chat" that stripping exists to prevent.
 */
const ARTIFACT_BLOCK = /<boltArtifact\s+[^>]*>[\s\S]*?<\/boltArtifact>/gm;

/**
 * The visible text of a user message — model/provider tags and machine artifacts removed.
 *
 * NOT trimmed: this feeds `Markdown`, and the component has rendered it untrimmed since upstream. Use
 * `copyableUserMessageText` for the clipboard, where trailing whitespace left by a stripped artifact is
 * pure noise in whatever the user pastes into.
 */
export function userMessageText(content: UserMessageContent): string {
  const text = typeof content === 'string' ? content : (content.find((item) => item.type === 'text')?.text ?? '');

  return text.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '').replace(ARTIFACT_BLOCK, '');
}

/**
 * The same text, ready for the clipboard.
 *
 * Trimmed, and EMPTY means "there is nothing to copy" — an image-only message renders a bubble with no
 * words in it, and a Copy button there would put an empty string on the clipboard while reporting
 * success, which is worse than not offering one.
 */
export function copyableUserMessageText(content: UserMessageContent): string {
  return userMessageText(content).trim();
}
