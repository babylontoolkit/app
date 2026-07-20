# `@babylonjs-toolkit/bridge`

Lets the browser-based app builder drive your **local Unity Editor** with the platform's AI credits.

The app builder runs in a browser and the platform server can never reach your machine (it refuses
private/loopback addresses by design). So the connection is made by the **browser itself**, to this
companion running on `127.0.0.1`. The AI orchestration, billing, and tool loop all stay on the
platform; only the tool *execution* happens here, against your Editor.

```
Browser (app builder)  ──HTTP MCP──▶  companion (127.0.0.1)  ──▶  Unity MCP server  ──▶  Unity Editor
```

## Setup

**1. Install the Unity package** (CoplayDev's MCP for Unity, MIT) in your Unity project — Package
Manager → *Add package from git URL*:

```
https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main
```

**2. Install [uv](https://docs.astral.sh/uv/)** (provides `uvx`), unless you plan to run the Unity MCP
server yourself and use `--attach`.

**3. With the Unity Editor open, run the companion:**

```bash
npx @babylonjs-toolkit/bridge
```

It prints a **port** and a **pairing token**. Paste both into the *Connect Unity* dialog in the app
builder. That's it — the Unity tools appear in your project chat.

## Options

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port <n>` | `8080` | Port the browser connects to. |
| `--attach <n>` | — | Use an already-running Unity MCP server on this port instead of launching one. |
| `--origin <url>` | any | Only accept requests from this app origin. |
| `--token <secret>` | random | Use a fixed pairing token instead of a fresh one per run. |
| `--server-command <cmd>` | `uvx --from mcpforunityserver mcp-for-unity` | Override how the Unity MCP server is launched. |

> **If startup fails with the default command**, upstream's published docs disagree about how HTTP
> mode is selected across versions. Start the Unity MCP server yourself in HTTP mode and use
> `--attach <its port>`, or override the whole invocation with `--server-command`.

## Security

- **Binds `127.0.0.1` only.** Never `0.0.0.0` — the upstream server's default would be reachable from
  your whole LAN; the companion is not.
- **Pairing token required.** Every request must carry `Authorization: Bearer <token>`, compared in
  constant time. A fresh token is minted each run, so it never outlives the session it authorised.
  The preflight is intentionally exempt: browsers never attach credentials to a preflight.
- **CORS + Private Network Access.** An HTTPS page reaching a loopback address needs an explicit
  `Access-Control-Allow-Private-Network: true` preflight answer; without it the browser reports a
  generic network error. Use `--origin` to restrict which app origin may connect.
- **Tools act on your Editor.** They can create, modify, and delete assets in the open Unity project —
  the same power you'd give any MCP client. Run it against a project under version control.

## Same machine, by design

Your browser must be on the **same computer** as the Unity Editor — the connection is to `127.0.0.1`
and never leaves the machine. That is deliberate: your Editor is not reachable from your network, and
no relay or tunnel is holding a credential on your behalf. Remote Unity is explicitly not supported.

## Browser support

Chrome and Edge are the supported browsers. They treat loopback as a potentially-trustworthy origin,
so an HTTPS page may reach `http://127.0.0.1`. Safari and Firefox block or restrict this in some
versions.

## Development

From the repository root:

```bash
pnpm companion --attach 8081   # run from source
cd companion && npm test       # node:test, zero dependencies
```

Publishing: `cd companion && npm publish --access public`.

## License

MIT. Bundles nothing; launches [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) (MIT) via
`uvx` at runtime.
