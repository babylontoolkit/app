/**
 * The WebContainer implementation of {@link SandboxProvider} (SPEC §8, `spec/sandbox-seam.md`).
 *
 * This is the ONLY module in the app that is allowed to know WebContainer exists, besides the boot
 * module it wraps (`~/lib/webcontainer`) and upstream's own StackBlitz auth/connect files.
 * `sandbox-seam.spec.ts` enforces that as a default-deny source scan.
 *
 * It is deliberately a thin delegation rather than a reimplementation: WebContainer is the runtime
 * we ship today and this refactor must be behaviour-preserving. The translation it does perform is
 * exactly the part worth naming — `internal.watchPaths` and `internal.textSearch` are `@unstableInternal`
 * in StackBlitz's own type definitions, i.e. the two calls most likely to break under us and the two
 * a server provider implements completely differently. Everything else passes straight through.
 */
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type {
  SandboxCapabilities,
  SandboxFileTree,
  SandboxProcess,
  SandboxProvider,
  SandboxSpawnOptions,
  SandboxTextSearchOptions,
  SandboxTextSearchProgress,
  SandboxWatchEvent,
  SandboxWatchOptions,
} from './types';

/**
 * WebContainer does the first three. Stated as a constant rather than inlined so the contrast with
 * a server provider is a one-line diff in a readable place.
 *
 * `clearPort` is false BECAUSE it is unneeded, not because it is unimplementable: a WebContainer
 * dies with the tab, so no port can be inherited from a previous page session. (A dev server does
 * survive SPA navigation within one page — creating a project right after another in the same tab
 * keeps upstream's long-standing behaviour: the old server keeps serving the newly-mounted files.)
 */
export const WEBCONTAINER_CAPABILITIES: SandboxCapabilities = {
  terminal: true,
  textSearch: true,
  watch: true,
  clearPort: false,

  /*
   * WebContainer's Node is itself WebAssembly; there is no dlopen and no `.node` to load. Rolldown
   * carries a WebContainer-only fallback that pnpm-installs its WASM binding into /tmp — gated on
   * `process.versions.webcontainer`, so it never fires anywhere else — but declaring the truth here
   * costs nothing and means an import stops depending on a vendor's private escape hatch.
   */
  nativeAddons: false,

  /** `setPreviewScript` is a first-class WebContainer API — this is the provider it was built against. */
  previewScript: true,
};

export function createWebContainerProvider(container: WebContainer): SandboxProvider {
  return {
    capabilities: WEBCONTAINER_CAPABILITIES,

    /*
     * The dev-tools channel (`lib/preview/protocol.ts`). This call is not new — it has existed since
     * upstream — but it used to be made in `webcontainer/index.ts`, OUTSIDE the seam, which is why the
     * capability silently did not exist on any other provider.
     */
    async setPreviewScript(script: string) {
      await container.setPreviewScript(script);
    },

    /*
     * A WebContainer dies with the tab; every page load boots an empty filesystem. `false` is what
     * makes the mount path restore the working copy / local checkpoint — here that restore IS the
     * project, not an overwrite of one.
     */
    bootRestoredFilesystem: false,

    /**
     * WebContainer ships its own shell, `jsh`, which announces interactivity with an OSC escape.
     * Both values are WebContainer-specific and lived hardcoded in `shell.ts` until a second
     * provider turned that into a terminal printing `/bin/jsh: No such file or directory`.
     */
    shell: { command: '/bin/jsh', args: ['--osc'], readyOsc: 'interactive' },

    /*
     * A getter, not a captured value: `workdir` is a getter on WebContainer too, and every path in
     * the app is rebased against it. Snapshotting it here would be correct today and silently wrong
     * for any provider whose sandbox is created lazily or moves between hosts.
     */
    get workdir(): string {
      return container.workdir;
    },

    fs: container.fs,

    async mount(tree: SandboxFileTree, options?: { mountPoint?: string }): Promise<void> {
      await container.mount(tree as FileSystemTree, options);
    },

    spawn(command: string, args: string[] = [], options?: SandboxSpawnOptions): Promise<SandboxProcess> {
      return container.spawn(command, args, options);
    },

    watchPaths(options: SandboxWatchOptions, callback: (events: SandboxWatchEvent[]) => void): () => void {
      return container.internal.watchPaths(options, callback);
    },

    onServerReady(listener: (port: number, url: string) => void): () => void {
      return container.on('server-ready', listener);
    },

    onPort(listener: (port: number, type: 'open' | 'close', url: string) => void): () => void {
      return container.on('port', listener);
    },

    async textSearch(
      query: string,
      options: SandboxTextSearchOptions,
      onProgress: SandboxTextSearchProgress,
    ): Promise<void> {
      // The Map of results is discarded: every caller consumes matches incrementally via onProgress.
      await container.internal.textSearch(query, options, onProgress);
    },

    teardown(): void {
      container.teardown();
    },
  };
}
