/**
 * @vitest-environment jsdom
 *
 * Unity Project Licenser — client-side delivery of `license.json` (SPEC §4.18, T7).
 *
 * Three delivery paths, none of which spend credits: a WebContainer write (rides the repo on save),
 * a best-effort MCP drop into the OPEN local Unity project, and a plain browser download. These tests
 * drive the real module with only the workbench store and the Unity bridge mocked. The Unity drop's
 * load-bearing property is that a DISCONNECTED bridge never calls a tool (mutation-verified: 0 calls).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpTool } from '~/lib/mcp/webcontainer-bridge';
import type { UnityConnectionState } from '~/lib/stores/unityBridge';

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { createFile: vi.fn(async () => true) },
}));

/** Mutable state the mocked atoms read; each test sets what it needs. */
let connectionState: UnityConnectionState = { status: 'disconnected' };
let toolsState: McpTool[] = [];

vi.mock('~/lib/stores/unityBridge', () => ({
  unityConnectionAtom: { get: () => connectionState },
  unityToolsAtom: { get: () => toolsState },
  callUnityTool: vi.fn(async () => ({ ok: true })),
}));

import { workbenchStore } from '~/lib/stores/workbench';
import { callUnityTool } from '~/lib/stores/unityBridge';
import {
  writeLicenseToWebProject,
  dropLicenseIntoUnity,
  downloadLicense,
  WEB_LICENSE_PATH,
  UNITY_LICENSE_PATH,
  type UnityLicense,
} from './license-delivery';

const createFileMock = workbenchStore.createFile as unknown as ReturnType<typeof vi.fn>;
const callUnityToolMock = callUnityTool as unknown as ReturnType<typeof vi.fn>;

function fixture(): UnityLicense {
  return {
    licensee: 'Ada Lovelace',
    product: 'BabylonToolkit',
    project: 'Kart Racer',
    secret: 's3cr3t',
    trial: false,
    plan: 'pro',
    org: 'acme',
    key: 'AAAA-BBBB-CCCC',
    s1: 'sig-one',
    s2: 'sig-two',
    expires: '2027-01-01',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createFileMock.mockImplementation(async () => true);
  callUnityToolMock.mockImplementation(async () => ({ ok: true }));
  connectionState = { status: 'disconnected' };
  toolsState = [];
});

describe('writeLicenseToWebProject', () => {
  it('writes the EXACT root path with 2-space pretty-printed JSON', async () => {
    const license = fixture();
    await writeLicenseToWebProject(license);

    expect(createFileMock).toHaveBeenCalledTimes(1);

    const [path, contents] = createFileMock.mock.calls[0];
    expect(path).toBe('/home/project/license.json');
    expect(path).toBe(`/home/project/${WEB_LICENSE_PATH}`);
    expect(contents).toBe(JSON.stringify(license, null, 2));

    // pretty-printed => newline + two-space indent
    expect(contents).toContain('\n  "licensee":');
  });

  it('surfaces true when the write lands', async () => {
    createFileMock.mockImplementation(async () => true);
    await expect(writeLicenseToWebProject(fixture())).resolves.toBe(true);
  });

  it('surfaces false when createFile returns false', async () => {
    createFileMock.mockImplementation(async () => false);
    await expect(writeLicenseToWebProject(fixture())).resolves.toBe(false);
  });

  it('surfaces false when createFile throws', async () => {
    createFileMock.mockImplementation(async () => {
      throw new Error('disk full');
    });
    await expect(writeLicenseToWebProject(fixture())).resolves.toBe(false);
  });
});

describe('dropLicenseIntoUnity', () => {
  const writeTool: McpTool = {
    name: 'create_asset',
    description: 'Create an asset file in the project',
    server: 'unity',
    inputSchema: {
      type: 'object',
      properties: { path: {}, contents: {} },
    },
  };

  it('does NOT call any tool when disconnected — returns { ok: false }', async () => {
    connectionState = { status: 'disconnected' };
    toolsState = [writeTool];

    const result = await dropLicenseIntoUnity(fixture());

    expect(result.ok).toBe(false);
    expect(callUnityToolMock).toHaveBeenCalledTimes(0);
  });

  it('passes the Assets/[Config]/license.json destination to the discovered tool', async () => {
    connectionState = { status: 'connected', port: 17932, toolCount: 1 };
    toolsState = [writeTool];

    const license = fixture();
    const result = await dropLicenseIntoUnity(license);

    expect(result).toEqual({ ok: true, tool: 'create_asset' });
    expect(callUnityToolMock).toHaveBeenCalledTimes(1);

    const [toolName, args] = callUnityToolMock.mock.calls[0];
    expect(toolName).toBe('create_asset');

    const values = Object.values(args as Record<string, unknown>);
    expect(values).toContain(UNITY_LICENSE_PATH);
    expect(values).toContain('Assets/[Config]/license.json');
    expect(values).toContain(JSON.stringify(license, null, 2));
  });

  it('propagates a tool-call failure as { ok: false, reason }', async () => {
    connectionState = { status: 'connected', port: 17932, toolCount: 1 };
    toolsState = [writeTool];
    callUnityToolMock.mockImplementation(async () => {
      throw new Error('Unity rejected the write');
    });

    const result = await dropLicenseIntoUnity(fixture());

    expect(result).toEqual({ ok: false, reason: 'Unity rejected the write' });
    expect(callUnityToolMock).toHaveBeenCalledTimes(1);
  });

  it('returns { ok: false, reason } when connected but no tools are available', async () => {
    connectionState = { status: 'connected', port: 17932, toolCount: 0 };
    toolsState = [];

    const result = await dropLicenseIntoUnity(fixture());

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }

    expect(callUnityToolMock).toHaveBeenCalledTimes(0);
  });

  it('returns { ok: false, reason } when no tool is a write/asset tool', async () => {
    connectionState = { status: 'connected', port: 17932, toolCount: 2 };
    toolsState = [
      { name: 'read_console', description: 'Read the editor console', server: 'unity', inputSchema: {} },
      { name: 'list_scenes', description: 'List open scenes', server: 'unity', inputSchema: {} },
    ];

    const result = await dropLicenseIntoUnity(fixture());

    expect(result.ok).toBe(false);
    expect(callUnityToolMock).toHaveBeenCalledTimes(0);
  });

  it('sets action:create for an action-dispatched tool schema', async () => {
    connectionState = { status: 'connected', port: 17932, toolCount: 1 };
    toolsState = [
      {
        name: 'manage_asset',
        description: 'Manage assets',
        server: 'unity',
        inputSchema: {
          type: 'object',
          properties: { action: {}, path: {}, contents: {} },
        },
      },
    ];

    const result = await dropLicenseIntoUnity(fixture());

    expect(result.ok).toBe(true);

    const [, args] = callUnityToolMock.mock.calls[0];
    expect((args as Record<string, unknown>).action).toBe('create');
    expect(Object.values(args as Record<string, unknown>)).toContain(UNITY_LICENSE_PATH);
  });
});

describe('downloadLicense', () => {
  it('creates an anchor named license.json and clicks it', () => {
    const createObjectURL = vi.fn(() => 'blob:license');
    const revokeObjectURL = vi.fn();

    // jsdom does not implement these on URL.
    (window.URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (window.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

    const clicked: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string): HTMLElement => {
      const el = realCreate(tag) as HTMLElement;

      if (tag === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => {
          clicked.push(el as HTMLAnchorElement);
        });
      }

      return el;
    }) as typeof document.createElement);

    downloadLicense(fixture());

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('license.json');
    expect(clicked[0].download).toBe(WEB_LICENSE_PATH);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    createSpy.mockRestore();
  });
});
