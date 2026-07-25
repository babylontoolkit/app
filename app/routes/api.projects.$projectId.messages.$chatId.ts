/**
 * One conversation — read, save, delete (SPEC §4.5.5, §4.5.6, §5).
 *
 * Both ids in the URL are values the CALLER chooses, so both are walled:
 *
 *   - `projectId` goes through `requireOwnedProject` — 404, never 403 (§4.5.3).
 *   - `chatId` goes through `messagesKey`, which accepts a minted UUID and nothing else. It is scoped
 *     under the owned project's prefix, so even a valid-looking id can only ever address a chat in a
 *     project the caller owns.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import {
  deleteChat,
  getChatOrLegacy,
  isValidChatId,
  listChats,
  putChat,
  MAX_CHATS_PER_PROJECT,
} from '~/lib/.server/projects/message-store';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.project-chat');

/**
 * Guard rail, not a policy. A conversation is text; a few MB is a very long chat. This exists so a
 * runaway client (or a hostile one — this is an authenticated HTTP endpoint, not our React code)
 * cannot push unbounded bytes into our object store on the platform's dime.
 */
const MAX_MESSAGES_BYTES = 25_000_000;

const badRequest = (message: string, status: number) =>
  json({ error: true, message, statusCode: status, isRetryable: false }, { status });

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const chatId = params.chatId!;

    if (!isValidChatId(chatId)) {
      return badRequest('Not a chat id.', 400);
    }

    const chat = await getChatOrLegacy(project.id, chatId, context);

    /*
     * A chat that is not there is a 404 — unlike the LIST, where "nothing yet" is a real answer. The
     * caller named a specific conversation; if it is gone, saying so is more useful than an empty one
     * they might then save over.
     */
    if (!chat) {
      return badRequest('This conversation does not exist.', 404);
    }

    return json({ chat });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const chatId = params.chatId!;

    if (!isValidChatId(chatId)) {
      return badRequest('Not a chat id.', 400);
    }

    if (request.method === 'DELETE') {
      await deleteChat(project.id, chatId, context);
      return json({ ok: true });
    }

    /*
     * PATCH — rename only (§4.5.6). This exists because the sidebar is the SERVER's chat list: a
     * rename written only to IndexedDB is overwritten the moment the list refreshes (the server
     * row's title wins in `mergeChatList`), and it never existed on any other device. `putChat`
     * writes the object first and the index second, so the title stays one fact with one home.
     */
    if (request.method === 'PATCH') {
      const body = await request.json<{ title?: string }>();
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';

      if (!title) {
        return badRequest('Expected a title.', 400);
      }

      const chat = await getChatOrLegacy(project.id, chatId, context);

      if (!chat) {
        return badRequest('This conversation does not exist.', 404);
      }

      await putChat(
        project.id,

        // `serverChatId: chatId` also adopts a legacy chat under its real id, exactly like a save.
        { ...chat, serverChatId: chatId, title, updatedAt: new Date().toISOString() },
        context,
      );

      return json({ ok: true });
    }

    const body = await request.json<{ messages?: unknown[]; title?: string; createdAt?: string }>();

    if (!Array.isArray(body.messages)) {
      return badRequest('Expected a list of messages.', 400);
    }

    if (new TextEncoder().encode(JSON.stringify(body.messages)).length > MAX_MESSAGES_BYTES) {
      return badRequest('This conversation is too large to save. Start a new chat to keep building.', 413);
    }

    /*
     * Cap the COUNT, but never refuse a chat that already exists — a save is the user's work, and the
     * one thing worse than too many chats is losing the one they are in. This only refuses a NEW chat.
     */
    const existing = await listChats(project.id, context);
    const isNew = !existing.some((chat) => chat.serverChatId === chatId);

    if (isNew && existing.length >= MAX_CHATS_PER_PROJECT) {
      return badRequest(`A project can hold ${MAX_CHATS_PER_PROJECT} chats. Delete one to start another.`, 409);
    }

    const now = new Date().toISOString();

    await putChat(
      project.id,
      {
        serverChatId: chatId,
        title: body.title?.slice(0, 120),
        createdAt: body.createdAt ?? now,
        updatedAt: now,
        messages: body.messages,
      },
      context,
    );

    // `updatedAt` is what sorts the project list — a chat that moved is a project that moved.
    await getProjectStore(context).update(project.id, {});

    logger.debug(`Saved ${body.messages.length} messages to chat ${chatId} of project ${project.id}`);

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
