/**
 * The Assets tab (SPEC §4.9).
 *
 * Two sections: the STORE catalog (hosted scenes, interactive prefabs, packs — read from
 * `/api/assets/catalog`) and MY UPLOADS for the current project (models/textures/audio, validated and
 * introspected server-side). Uploading a model runs the §4.9 introspection on the server, so the agent
 * learns the asset's real components; the tab just surfaces whether that happened ("components read").
 *
 * Uploads are read in the browser as base64 and POSTed — the same wire format snapshots and share
 * builds use, so binaries stay byte-faithful. All validation (type, size, quota, structure) is on the
 * server; the client cap here is only a courtesy to reject the obviously-too-big before the round trip.
 */
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { projectId as projectIdStore } from '~/lib/persistence';
import { bytesToBase64 } from '~/lib/binary/binary-files';

interface CatalogScene {
  id: string;
  title: string;
  description: string;
  sceneUrl: string;
  premium: boolean;
}
interface CatalogPrefab {
  id: string;
  title: string;
  description: string;
  components: string[];
  premium: boolean;
}
interface CatalogPack {
  id: string;
  title: string;
  description: string;
  premium: boolean;
}
interface Catalog {
  scenes: CatalogScene[];
  prefabs: CatalogPrefab[];
  packs: CatalogPack[];
}

interface UserAsset {
  id: string;
  filename: string;
  kind: string;
  byteSize: number;
  hasComponents: boolean;
}

const CLIENT_MAX_BYTES = 50 * 1024 * 1024;

export function AssetsTab() {
  const activeProjectId = useStore(projectIdStore);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [assets, setAssets] = useState<UserAsset[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    fetch('/api/assets/catalog')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setCatalog(data as Catalog))
      .catch(() => undefined);
  }, []);

  const loadAssets = () => {
    if (!activeProjectId) {
      return;
    }

    fetch(`/api/projects/${activeProjectId}/assets`)
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((data) => setAssets((data as { assets: UserAsset[] }).assets ?? []))
      .catch(() => undefined);
  };

  useEffect(loadAssets, [activeProjectId]);

  const onUpload = async (file: File) => {
    if (!activeProjectId) {
      toast.error('Open a project first.');
      return;
    }

    if (file.size > CLIENT_MAX_BYTES) {
      toast.error('That file is larger than 50 MB.');
      return;
    }

    setUploading(true);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const response = await fetch(`/api/projects/${activeProjectId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, base64: bytesToBase64(bytes) }),
      });

      const data = (await response.json()) as { ok?: boolean; message?: string; asset?: { hasComponents?: boolean } };

      if (response.ok && data.ok) {
        toast.success(data.asset?.hasComponents ? 'Uploaded — components read for the agent.' : 'Uploaded.');
        loadAssets();
      } else {
        toast.error(data.message ?? 'Upload failed.');
      }
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (assetId: string) => {
    if (!activeProjectId) {
      return;
    }

    const response = await fetch(`/api/projects/${activeProjectId}/assets`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId }),
    });

    if (response.ok) {
      loadAssets();
    }
  };

  return (
    <div className="flex flex-col gap-6 p-1">
      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Your uploads</h3>
        <p className="text-xs text-bolt-elements-textSecondary mt-0.5">
          Add your own models (.glb/.gltf), textures, or audio. The agent reads a model's components automatically.
        </p>

        {!activeProjectId ? (
          <div className="mt-3 text-sm text-bolt-elements-textSecondary">Open a project to upload assets.</div>
        ) : (
          <>
            <label className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-500 text-white text-sm cursor-pointer hover:bg-bolt-elements-button-primary-backgroundHover">
              <span className="i-ph:upload-simple" />
              {uploading ? 'Uploading…' : 'Upload asset'}
              <input
                type="file"
                className="hidden"
                accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.ktx2,.mp3,.ogg,.wav,.m4a"
                disabled={uploading}
                onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
              />
            </label>

            <div className="mt-3 flex flex-col gap-1.5">
              {assets.length === 0 ? (
                <div className="text-sm text-bolt-elements-textSecondary">No uploads yet.</div>
              ) : (
                assets.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-md border border-bolt-elements-borderColor"
                  >
                    <span className="i-ph:file-3d text-bolt-elements-textSecondary" />
                    <span className="text-sm text-bolt-elements-textPrimary flex-1 truncate">{a.filename}</span>
                    {a.hasComponents && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                        components read
                      </span>
                    )}
                    <span className="text-xs text-bolt-elements-textTertiary">
                      {(a.byteSize / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button
                      className="i-ph:trash text-bolt-elements-textTertiary hover:text-red-500"
                      onClick={() => onDelete(a.id)}
                      title="Remove"
                    />
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Asset store</h3>
        <p className="text-xs text-bolt-elements-textSecondary mt-0.5">
          Hosted scenes and interactive prefabs you can add to any project.
        </p>

        {!catalog ? (
          <div className="mt-3 text-sm text-bolt-elements-textSecondary">Loading…</div>
        ) : (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[...catalog.prefabs, ...catalog.scenes].map((item) => (
              <div key={item.id} className="rounded-md border border-bolt-elements-borderColor p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-bolt-elements-textPrimary">{item.title}</span>
                  {item.premium && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-500">Premium</span>
                  )}
                </div>
                <p className="text-xs text-bolt-elements-textSecondary mt-1">{item.description}</p>
                {'components' in item && item.components.length > 0 && (
                  <div className="mt-1.5 text-xs text-bolt-elements-textTertiary">{item.components.join(' · ')}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
