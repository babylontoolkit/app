#!/usr/bin/env node
/**
 * kie-image-mcp — one package, three MCP servers (zero runtime deps, Node 18+).
 * Works from Claude Code, GitHub Copilot Chat, Cursor, and any MCP client.
 *
 * Usage (the subcommand selects which server to run over stdio):
 *   npx -y kie-image-mcp image    -> kie.ai image generation (generate_image)
 *   npx -y kie-image-mcp video    -> Kling / Bytedance / Grok video (generate_video)
 *   npx -y kie-image-mcp google   -> Google Veo 3.1 video (generate_google_video)
 *
 * Default (no subcommand) is `image`.
 */
import * as image from "./image.js";
import * as video from "./video.js";
import * as google from "./google.js";

const which = (process.argv[2] || "image").toLowerCase();

switch (which) {
  case "image":
    image.run();
    break;
  case "video":
    video.run();
    break;
  case "google":
  case "veo":
    google.run();
    break;
  default:
    console.error(
      `[kie-image-mcp] unknown subcommand "${which}". Use one of: image | video | google`
    );
    process.exit(2);
}
