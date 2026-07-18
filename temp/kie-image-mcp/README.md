# Babylon Toolkit MCP Servers

| Subcommand | Server | Tool | Models |
|---|---|---|---|
| `image` (default) | kie-image | `generate_image` | Nano Banana 2, Imagen 4, Seedream, Flux-2, Qwen, … |
| `video` | kie-video | `generate_video` | Kling, Bytedance Seedance, Grok Imagine |
| `google` | kie-google | `generate_google_video` | Google Veo 3.1 (`veo3` / `veo3_fast` / `veo3_lite`) |

Because MCP is an open protocol, the same package works from **Claude Code, GitHub
Copilot Chat (VS Code), Cursor, Windsurf, Zed**, and any other MCP client — one package,
every AI. Built with only Node built-ins (`fetch`, `fs`, `readline`), so it pulls no
transitive packages. Requires **Node 18+**.

The command takes one subcommand to pick the server (defaults to `image`):
```
kie-image-mcp image     # or: video | google   (no arg = image)
```

## Get an API key
Set your kie.ai key as `KIE_KEY` (or `KIE_AI_API_KEY`), or put `KIE_KEY=...` in a `.env`
file in your working directory. See `.env.example`. All three servers share the one key.

## Install (global)
The npm package is published as **`@babylonjs-toolkit/mcp`**; it installs a command named
**`kie-image-mcp`** (that command name is what you reference everywhere else). Install once
so the command is on your PATH:
```
npm install -g @babylonjs-toolkit/mcp   # from npm once published
# or, from a local clone (the prepare script builds it for you):
cd kie-image-mcp && npm install -g .
```
Verify and update:
```
which kie-image-mcp                        # confirm the command is on PATH
npm install -g @babylonjs-toolkit/mcp@latest   # update to a newer version
```

> **nvm users:** the global bin is tied to the active Node version (e.g.
> `~/.nvm/versions/node/vXX/bin/kie-image-mcp`). If you switch Node versions, reinstall
> for that version. If your MCP client is a GUI app that doesn't inherit your shell PATH,
> use the absolute bin path (from `which kie-image-mcp`) in the config.

## Configure (any MCP client)

Register one entry per server you want; the subcommand goes in `args`. `KIE_KEY` is read
from your environment or a `.env` file (add `"env": { "KIE_KEY": "..." }` to an entry to
set it inline).

### Claude Code
Add to your project `.mcp.json` (or user `~/.claude.json`):
```json
{
  "mcpServers": {
    "kie-image":  { "command": "kie-image-mcp", "args": ["image"] },
    "kie-video":  { "command": "kie-image-mcp", "args": ["video"] },
    "kie-google": { "command": "kie-image-mcp", "args": ["google"] }
  }
}
```
GUI-PATH fallback — use the absolute bin path from `which kie-image-mcp`:
```json
{ "mcpServers": { "kie-image": { "command": "/Users/you/.nvm/versions/node/v24.11.0/bin/kie-image-mcp", "args": ["image"] } } }
```

### GitHub Copilot Chat (VS Code)
`.vscode/mcp.json`:
```json
{
  "servers": {
    "kie-image":  { "command": "kie-image-mcp", "args": ["image"] },
    "kie-video":  { "command": "kie-image-mcp", "args": ["video"] },
    "kie-google": { "command": "kie-image-mcp", "args": ["google"] }
  }
}
```

### Cursor / Windsurf / Zed / generic
Same shape under the client's `mcpServers` key, using the `kie-image-mcp` command.
