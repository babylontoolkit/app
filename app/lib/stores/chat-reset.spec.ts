/**
 * @vitest-environment jsdom
 *
 * "New chat, same game" is IN PLACE — pinning the two properties the signal rests on (§4.5.6, §4.2.9).
 *
 * The regression this guards is not subtle to a user and invisible to a test suite: routing the action
 * back through the mount baton re-mounts a project that never left, so the workbench tears down and
 * slides back in to deliver an empty chat. Every store and route involved stays green while it happens.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { atom } from 'nanostores';
import { chatResetRequest, requestChatReset } from './chat-reset';

/*
 * `useChatHistory` is the builder's whole persistence module — importing it here would drag the
 * WebContainer in with it. The hook uses exactly one thing from it: the active project atom.
 */
vi.mock('~/lib/persistence/useChatHistory', () => ({ projectId: atom<string | undefined>(undefined) }));
import { PENDING_OPEN_KEY, PENDING_FRESH_CHAT_KEY } from '~/lib/persistence/pending-remix';
import { projectId } from '~/lib/persistence/useChatHistory';
import { useStartNewChat } from '~/components/chat/NewChatButton.client';

describe('chatResetRequest', () => {
  beforeEach(() => {
    chatResetRequest.set(0);
  });

  it('changes value on every request, so a listener sees each one', () => {
    const seen: number[] = [];
    const unsubscribe = chatResetRequest.listen((value) => seen.push(value));

    requestChatReset();
    requestChatReset();
    unsubscribe();

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('never repeats a value — a listener comparing against the last one it saw cannot miss a request', () => {
    const values = new Set<number>();

    for (let i = 0; i < 5; i++) {
      requestChatReset();
      values.add(chatResetRequest.get());
    }

    expect(values.size).toBe(5);
  });
});

describe('useStartNewChat', () => {
  beforeEach(() => {
    chatResetRequest.set(0);
    sessionStorage.clear();
    projectId.set(undefined);
  });

  it('resets the conversation in place and parks NO mount baton (the project is already open)', () => {
    projectId.set('project-1');

    const { result } = renderHook(() => useStartNewChat());
    result.current();

    expect(chatResetRequest.get()).toBe(1);

    /*
     * 🔴 The regression, stated as an absence: a baton here makes the builder re-mount the project on
     * its next load — which is precisely the "the whole workspace reloaded" symptom.
     */
    expect(sessionStorage.getItem(PENDING_OPEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_FRESH_CHAT_KEY)).toBeNull();
  });

  it('does nothing with no project — "same game" has no game to be the same as', () => {
    const { result } = renderHook(() => useStartNewChat());
    result.current();

    expect(chatResetRequest.get()).toBe(0);
  });

  it('does not navigate — a route change remounts the builder, which is the reload being removed', () => {
    projectId.set('project-1');

    const assign = vi.fn();
    const before = window.location.href;

    const { result } = renderHook(() => useStartNewChat());
    result.current();

    expect(assign).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });
});
