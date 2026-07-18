/**
 * Shared core for the kie-mcp servers (image / video / google).
 * Zero runtime dependencies — Node built-ins only.
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";

export const API = "https://api.kie.ai";
export const UPLOAD = "https://kieai.redpandaai.co";
export const DEFAULT_PROTOCOL = "2025-06-18";

export function makeLog(tag: string) {
  return (...a: unknown[]): void => console.error(`[${tag}]`, ...a);
}

function parseEnvFile(path: string): Record<string, string> {
  const vals: Record<string, string> = {};
  try {
    const txt = readFileSync(path, "utf8");
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      let key = line.slice(0, idx).trim();
      if (key.startsWith("export ")) key = key.slice(7).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      vals[key] = val;
    }
  } catch {
    /* missing .env is fine */
  }
  return vals;
}

export function getKey(): string {
  for (const v of ["KIE_KEY", "KIE_AI_API_KEY"]) {
    const e = process.env[v];
    if (e) return e.trim();
  }
  for (const p of [join(process.cwd(), ".env"), join(process.cwd(), "..", ".env")]) {
    const env = parseEnvFile(p);
    for (const v of ["KIE_KEY", "KIE_AI_API_KEY"]) if (env[v]) return env[v].trim();
  }
  throw new Error("No API key: set $KIE_KEY (or $KIE_AI_API_KEY), or add KIE_KEY=... to a .env file");
}

export function expand(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
function guessMime(p: string): string {
  const i = p.lastIndexOf(".");
  return (i >= 0 && MIME[p.slice(i).toLowerCase()]) || "image/jpeg";
}

/** HTTP/upload client bound to a server-specific User-Agent. */
export function createClient(ua: string) {
  const log = makeLog("kie");
  async function req(url: string, method = "GET", body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${getKey()}`,
      "User-Agent": ua,
      Accept: "application/json",
    };
    let data: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      data = JSON.stringify(body);
    }
    const r = await fetch(url, { method, headers, body: data });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`bad JSON from ${url}: ${text.slice(0, 300)}`);
    }
  }

  async function upload(path: string, uploadPath: string): Promise<string> {
    const raw = readFileSync(path);
    const b64 = raw.toString("base64");
    const mime = guessMime(path);
    const res = await req(`${UPLOAD}/api/file-base64-upload`, "POST", {
      base64Data: `data:${mime};base64,${b64}`,
      uploadPath,
      fileName: basename(path),
    });
    const url = res?.data?.downloadUrl;
    if (!url) throw new Error(`upload failed for ${path}: ${JSON.stringify(res).slice(0, 300)}`);
    log("uploaded", path, "->", url);
    return url;
  }

  return { req, upload };
}

/** Download a remote URL to a local path, creating parent dirs. */
export async function download(url: string, outPath: string, ua: string): Promise<void> {
  const dir = dirname(outPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const r = await fetch(url, { headers: { "User-Agent": ua } });
  writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
}

export interface ServerDef {
  name: string;
  version: string;
  tools: any[];
  /** Invoked only for tools that exist in `tools`. Returns the text result. */
  call: (toolName: string, args: any) => Promise<string>;
}

/** Run a stdio JSON-RPC MCP server for the given definition. */
export function serve(def: ServerDef): void {
  const log = makeLog(def.name);
  const send = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
  const toolNames = new Set(def.tools.map((t) => t.name));

  async function handle(reqMsg: any): Promise<void> {
    const method: string = reqMsg.method;
    const rid = reqMsg.id;
    const params = reqMsg.params || {};

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: rid,
        result: {
          protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: def.name, version: def.version },
        },
      });
    } else if (method === "notifications/initialized") {
      /* notification, no response */
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id: rid, result: { tools: def.tools } });
    } else if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      if (!toolNames.has(name)) {
        send({
          jsonrpc: "2.0",
          id: rid,
          result: { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true },
        });
        return;
      }
      try {
        const text = await def.call(name, args);
        send({ jsonrpc: "2.0", id: rid, result: { content: [{ type: "text", text }] } });
      } catch (e: any) {
        log("ERROR:", e?.message || e);
        send({
          jsonrpc: "2.0",
          id: rid,
          result: { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true },
        });
      }
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id: rid, result: {} });
    } else if (rid !== undefined && rid !== null) {
      send({
        jsonrpc: "2.0",
        id: rid,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }

  log("server started");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log("bad json:", e);
      return;
    }
    handle(msg).catch((e) => log("handler crash:", e));
  });
}
