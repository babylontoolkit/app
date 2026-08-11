import type { Plugin } from "vite";
export interface NodepodVitePluginOptions {
    /** Path to serve the SW from. Same origin as the page, must end in .js. Defaults to /__sw__.js. */
    path?: string;
}
export default function nodepod(opts?: NodepodVitePluginOptions): Plugin;
export { nodepod };
