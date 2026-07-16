/**
 * Asset introspection — "the agent knows what it just got" (SPEC §4.9, scene-components workflow).
 *
 * Interactive prefabs and scenes authored with the Babylon Toolkit Unity Exporter carry their
 * component descriptors INSIDE the glTF, as `CVTOOLS_unity_metadata` and in per-node `extras`. When a
 * user adds or references such an asset, the platform scans that metadata and produces a **component
 * reference** — the list of every attached component, its class, and its tuned properties — which is
 * injected into the agent's project context (§4.9). The agent then writes game logic against the
 * asset's ACTUAL components (a car prefab's `StandardCarController` with its real tuning) instead of
 * guessing at an API.
 *
 * This scanner is deliberately TOLERANT: exporter versions differ, third-party creators (§1.4) will
 * produce variations, and a malformed asset must degrade to "fewer components found", never throw. It
 * reads glTF JSON only — the GLB binary container is unwrapped by the caller (`glbToJson`), because the
 * component metadata always lives in the JSON chunk, never the binary buffers.
 */

export interface AssetComponent {
  /** The Toolkit/Unity component class, e.g. `StandardCarController`. */
  klass: string;

  /** The node it is attached to, for "the car body has …" context. */
  node?: string;

  /** Tuned properties the exporter wrote — the values the agent must respect, not re-invent. */
  properties: Record<string, unknown>;
}

export interface AssetIntrospection {
  components: AssetComponent[];

  /** Node names, so the agent can address parts of the asset by name. */
  nodes: string[];

  /** Distinct component classes, for a quick "this prefab is a car + AI" read. */
  classes: string[];
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Pull component descriptors off one node's `extras`.
 *
 * Handles the shapes seen across exporter versions: `extras.components[]`, `extras.metadata.components[]`,
 * and a single `extras.metadata` object with a `klass`/`type`/`alias` field. Each yields zero or more
 * components; unknown shapes yield none rather than erroring.
 */
function componentsFromExtras(extras: unknown, nodeName?: string): AssetComponent[] {
  const obj = asObject(extras);

  if (!obj) {
    return [];
  }

  const metadata = asObject(obj.metadata);
  const rawLists = [asArray(obj.components), metadata ? asArray(metadata.components) : []];
  const out: AssetComponent[] = [];

  for (const list of rawLists) {
    for (const raw of list) {
      const comp = asObject(raw);

      if (!comp) {
        continue;
      }

      const klass = firstString(comp.klass, comp.type, comp.alias, comp.name);

      if (klass) {
        out.push({ klass, node: nodeName, properties: asObject(comp.properties) ?? stripKnownKeys(comp) });
      }
    }
  }

  // A metadata object that is itself a single component (no `components` array).
  if (out.length === 0 && metadata) {
    const klass = firstString(metadata.klass, metadata.type, metadata.alias);

    if (klass) {
      out.push({ klass, node: nodeName, properties: asObject(metadata.properties) ?? stripKnownKeys(metadata) });
    }
  }

  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }

  return undefined;
}

/** When a component object has no explicit `properties`, treat its non-identity keys as the properties. */
function stripKnownKeys(comp: Json): Record<string, unknown> {
  const { klass, type, alias, name, ...rest } = comp;
  void klass;
  void type;
  void alias;
  void name;

  return rest;
}

export function introspectGltf(gltf: unknown): AssetIntrospection {
  const doc = asObject(gltf);
  const components: AssetComponent[] = [];
  const nodes: string[] = [];

  if (!doc) {
    return { components: [], nodes: [], classes: [] };
  }

  // Per-node components (the common case: a prefab's parts each carry their descriptors).
  for (const rawNode of asArray(doc.nodes)) {
    const node = asObject(rawNode);

    if (!node) {
      continue;
    }

    const name = firstString(node.name);

    if (name) {
      nodes.push(name);
    }

    components.push(...componentsFromExtras(node.extras, name));
  }

  // Scene-level and document-level `CVTOOLS_unity_metadata` / top-level extras.
  const extensions = asObject(doc.extensions);

  if (extensions) {
    components.push(...componentsFromExtras(extensions.CVTOOLS_unity_metadata));
  }

  components.push(...componentsFromExtras(doc.extras));

  const classes = [...new Set(components.map((c) => c.klass))];

  return { components, nodes, classes };
}

/**
 * Render a component reference as the markdown note that goes into the agent's context (§4.9).
 *
 * Kept compact — this is injected on every generation for the project, so it earns its tokens by being
 * a reference, not a dump. Properties are summarised (names + values), truncated per component, because
 * the agent needs to know a property EXISTS and its tuned value, not read a hundred of them.
 */
export function renderComponentReference(assetName: string, introspection: AssetIntrospection): string | null {
  if (introspection.components.length === 0) {
    return null;
  }

  const lines = [
    `# Asset Component Reference: ${assetName}`,
    '',
    'This asset carries Babylon Toolkit components (authored with the Unity Exporter). Write game logic',
    'against these ACTUAL components and their tuned properties — do not re-invent an API for them:',
    '',
  ];

  for (const comp of introspection.components) {
    const where = comp.node ? ` on \`${comp.node}\`` : '';
    const props = summariseProps(comp.properties);
    lines.push(`- **${comp.klass}**${where}${props ? ` — ${props}` : ''}`);
  }

  return lines.join('\n');
}

function summariseProps(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties).slice(0, 8);

  if (entries.length === 0) {
    return '';
  }

  return entries
    .map(([key, value]) => {
      const shown = typeof value === 'object' && value !== null ? '{…}' : String(value).slice(0, 40);
      return `${key}=${shown}`;
    })
    .join(', ');
}
