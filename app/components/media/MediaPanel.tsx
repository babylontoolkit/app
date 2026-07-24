/**
 * The Media generation panel (SPEC §4.16) — prompt + option dropdowns + the price BEFORE Generate.
 *
 * The price on the button is not an estimate: media prices are exact (the Marketplace price list), so
 * the panel quotes the server (`action:'quote'`, which uses the SAME lookup the debit uses) on every
 * option change, and the number shown is the number debited. Video is deliberately loud about cost —
 * a Kling 4K clip is four figures of credits, and the whole §4.16 billing design exists so nobody
 * finds that out afterwards.
 *
 * Options → payload mapping mirrors `agent/media-tools.ts` exactly: one convention, two callers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { trackMediaTask } from '~/lib/media/tasks';

interface MediaPanelProps {
  projectId: string;
  onClose: () => void;
}

interface FieldChoice {
  value: string;
  label: string;
}

interface FieldSpec {
  key: 'resolution' | 'mode' | 'sound' | 'duration' | 'aspectRatio' | 'outputFormat' | 'transparent';
  label: string;
  choices: FieldChoice[];
  default: string;
}

interface ModelSpec {
  id: string;
  label: string;
  fields: FieldSpec[];
}

const ASPECTS: FieldChoice[] = [
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
];

const aspect = (choices = ASPECTS): FieldSpec => ({ key: 'aspectRatio', label: 'Aspect', choices, default: '16:9' });
const sound: FieldSpec = {
  key: 'sound',
  label: 'Audio',
  choices: [
    { value: 'false', label: 'No audio' },
    { value: 'true', label: 'With audio' },
  ],
  default: 'false',
};
const duration = (values: number[], def: number): FieldSpec => ({
  key: 'duration',
  label: 'Duration',
  choices: values.map((v) => ({ value: String(v), label: `${v}s` })),
  default: String(def),
});
const resolution = (values: string[], def: string): FieldSpec => ({
  key: 'resolution',
  label: 'Resolution',
  choices: values.map((v) => ({ value: v, label: v })),
  default: def,
});

/** The curated model set — matches the Marketplace price list's media rows; the quote is the referee. */
const IMAGE_MODELS: ModelSpec[] = [
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2 (default)',
    fields: [
      resolution(['1K', '2K', '4K'], '2K'),
      aspect(),

      /*
       * BACKGROUND, not FORMAT (§4.16). The dropdown this replaced offered "PNG — transparency",
       * which was a promise the pipeline could not keep: no image model on KIE emits an alpha
       * channel, so picking PNG bought a bigger file containing exactly the same opaque picture (and
       * often a checkerboard the model painted to depict the transparency it could not produce).
       *
       * Transparency is a second stage now (`recraft/remove-background`), so the question the user is
       * actually asked is the one that decides the pipeline: does this art sit over other content?
       * The quote below prices both stages, so the extra credits are on the button before Generate.
       */
      {
        key: 'transparent',
        label: 'Background',
        choices: [
          { value: 'false', label: 'Opaque — JPG' },
          { value: 'true', label: 'Transparent — PNG' },
        ],
        default: 'false',
      },
    ],
  },
  { id: 'nano-banana-2-lite', label: 'Nano Banana 2 Lite', fields: [resolution(['1K'], '1K'), aspect()] },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', fields: [resolution(['1K', '2K', '4K'], '2K'), aspect()] },
  { id: 'seedream/5-pro', label: 'Seedream 5 Pro', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
  { id: 'flux-2/pro', label: 'Flux 2 Pro', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
  { id: 'flux-2/flex', label: 'Flux 2 Flex', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
];

const VIDEO_MODELS: ModelSpec[] = [
  {
    id: 'kling-3.0/video',
    label: 'Kling 3.0 (default)',
    fields: [
      {
        key: 'mode',
        label: 'Quality',
        choices: [
          { value: 'std', label: 'Standard (720p)' },
          { value: 'pro', label: 'Pro (1080p)' },
          { value: '4K', label: '4K' },
        ],
        default: 'std',
      },
      sound,
      duration([5, 10], 5),
      aspect(ASPECTS.slice(0, 3)),
    ],
  },
  { id: 'kling-2.6', label: 'Kling 2.6', fields: [sound, duration([5, 10], 5), aspect(ASPECTS.slice(0, 3))] },
  {
    id: 'bytedance/seedance-2',
    label: 'Seedance 2',
    fields: [resolution(['480p', '720p', '1080p', '4K'], '720p'), sound, duration([5, 10], 5), aspect()],
  },
  {
    id: 'bytedance/seedance-2-fast',
    label: 'Seedance 2 Fast',
    fields: [resolution(['480p', '720p'], '720p'), sound, duration([5, 10], 5), aspect()],
  },
  {
    id: 'bytedance/seedance-1.5-pro',
    label: 'Seedance 1.5 Pro',
    fields: [resolution(['480p', '720p', '1080p'], '720p'), sound, duration([5, 10], 5), aspect()],
  },
  {
    id: 'grok-imagine-video-1-5-preview',
    label: 'Grok Imagine 1.5',
    fields: [resolution(['480p', '720p'], '720p'), duration([5, 10], 5), aspect(ASPECTS.slice(0, 3))],
  },
  {
    id: 'veo3_fast',
    label: 'Veo 3.1 Fast',
    fields: [resolution(['720p', '1080p', '4k'], '720p'), duration([4, 6, 8], 8), aspect(ASPECTS.slice(0, 2))],
  },
  {
    id: 'veo3',
    label: 'Veo 3.1 Quality',
    fields: [resolution(['720p', '1080p', '4k'], '720p'), duration([4, 6, 8], 8), aspect(ASPECTS.slice(0, 2))],
  },
  {
    id: 'veo3_lite',
    label: 'Veo 3.1 Lite',
    fields: [resolution(['720p', '1080p', '4k'], '720p'), duration([4, 6, 8], 8), aspect(ASPECTS.slice(0, 2))],
  },
];

interface TaskRow {
  id: string;
  kind: 'image' | 'video';
  model: string;
  prompt: string;
  destPath: string;
  status: 'pending' | 'succeeded' | 'failed';
  credits: number;
  error?: string;
}

/** The request body both quote and start send — one builder so they cannot disagree. */
function buildRequest(kind: 'image' | 'video', model: ModelSpec, values: Record<string, string>, prompt: string) {
  const options: Record<string, string | number | boolean> = {};
  let durationSeconds: number | undefined;

  for (const field of model.fields) {
    const value = values[field.key] ?? field.default;

    if (field.key === 'duration') {
      durationSeconds = Number(value);
    } else if (field.key === 'sound' || field.key === 'transparent') {
      // Booleans on the wire, never the string a <select> hands back (the service reads both, the price lookup does not).
      options[field.key] = value === 'true';
    } else {
      options[field.key] = value;
    }
  }

  // Mirrors `media-tools.ts`: seedance prices on prompt-only input in v1.
  if (model.id.startsWith('bytedance/')) {
    options.imageInput = false;
  }

  return { model: model.id, prompt, options, durationSeconds };
}

export function MediaPanel({ projectId, onClose }: MediaPanelProps) {
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const [modelId, setModelId] = useState(IMAGE_MODELS[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [credits, setCredits] = useState<number | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const models = kind === 'image' ? IMAGE_MODELS : VIDEO_MODELS;
  const model = useMemo(() => models.find((m) => m.id === modelId) ?? models[0], [models, modelId]);

  const switchKind = (next: 'image' | 'video') => {
    setKind(next);
    setModelId((next === 'image' ? IMAGE_MODELS : VIDEO_MODELS)[0].id);
    setValues({});
  };

  const loadTasks = useCallback(() => {
    fetch(`/api/projects/${projectId}/media`)
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((data) => setTasks(((data as { tasks?: TaskRow[] }).tasks ?? []).slice(0, 8)))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(loadTasks, [loadTasks]);

  /* The price on the button — re-quoted whenever anything that prices the task changes. */
  useEffect(() => {
    let cancelled = false;

    setCredits(null);
    setQuoteError(null);

    fetch(`/api/projects/${projectId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'quote', ...buildRequest(kind, model, values, '') }),
    })
      .then(async (r) => {
        const data = (await r.json()) as { credits?: number; message?: string };

        if (cancelled) {
          return;
        }

        if (r.ok && typeof data.credits === 'number') {
          setCredits(data.credits);
        } else {
          setQuoteError(data.message ?? 'This combination is not priced.');
        }
      })
      .catch(() => !cancelled && setQuoteError('Could not price this combination.'));

    return () => {
      cancelled = true;
    };
  }, [projectId, kind, model, values]);

  const generate = async () => {
    if (!prompt.trim()) {
      toast.error(`Describe the ${kind} you want to generate.`);
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', ...buildRequest(kind, model, values, prompt) }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        taskId?: string;
        destPath?: string;
        credits?: number;
        message?: string;
      };

      if (!response.ok || !data.ok || !data.taskId || !data.destPath) {
        toast.error(data.message ?? 'The generation could not start.');
        return;
      }

      toast.success(`Generating — ${data.credits} credits. It will be saved to ${data.destPath}.`);
      void trackMediaTask({ projectId, taskId: data.taskId, destPath: data.destPath, kind }).then(loadTasks);
      loadTasks();
      setPrompt('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] max-h-[85vh] overflow-y-auto rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Generate media</h2>
          <button className="i-ph:x text-bolt-elements-textSecondary" onClick={onClose} title="Close" />
        </div>

        <div className="flex gap-1 rounded-md border border-bolt-elements-borderColor p-0.5 self-start">
          {(['image', 'video'] as const).map((k) => (
            <button
              key={k}
              className={
                kind === k
                  ? 'px-3 py-1 text-xs rounded bg-accent-500 text-white'
                  : 'px-3 py-1 text-xs rounded text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2'
              }
              onClick={() => switchKind(k)}
            >
              {k === 'image' ? 'Image' : 'Video'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-bolt-elements-textSecondary col-span-2">
            Model
            <select
              className="px-2 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
              value={model.id}
              onChange={(e) => {
                setModelId(e.target.value);
                setValues({});
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {model.fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs text-bolt-elements-textSecondary">
              {field.label}
              <select
                className="px-2 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
                value={values[field.key] ?? field.default}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              >
                {field.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <textarea
          className="w-full h-20 text-sm p-2 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary resize-none"
          placeholder={
            kind === 'image'
              ? 'Describe the image — e.g. "seamless sci-fi metal floor texture, top-down, tileable"'
              : 'Describe the video — e.g. "cinematic flythrough of a neon city at night"'
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {quoteError && <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600">{quoteError}</div>}

        <button
          className="self-end px-4 py-2 text-sm rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
          disabled={busy || credits === null || !prompt.trim()}
          onClick={() => void generate()}
        >
          {busy ? 'Starting…' : credits !== null ? `Generate — ${credits.toLocaleString()} credits` : 'Generate'}
        </button>

        {tasks.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-bolt-elements-textSecondary">Recent</div>
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-xs"
              >
                <span
                  className={
                    task.status === 'succeeded'
                      ? 'i-ph:check-circle text-green-500'
                      : task.status === 'failed'
                        ? 'i-ph:x-circle text-red-500'
                        : 'i-svg-spinners:90-ring-with-bg text-bolt-elements-textSecondary'
                  }
                />
                <div className="flex-1 min-w-0">
                  <div className="text-bolt-elements-textPrimary truncate">{task.prompt || task.model}</div>
                  <div className="text-bolt-elements-textTertiary truncate">
                    {task.destPath} · {task.credits} credits
                    {task.status === 'failed' && ` · refunded${task.error ? ` — ${task.error}` : ''}`}
                  </div>
                </div>
                {task.status === 'pending' && (
                  <button
                    className="px-2 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                    onClick={() =>
                      void trackMediaTask({
                        projectId,
                        taskId: task.id,
                        destPath: task.destPath,
                        kind: task.kind,
                      }).then(loadTasks)
                    }
                  >
                    Resume
                  </button>
                )}
                {task.status === 'succeeded' && (
                  <button
                    className="px-2 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                    title="Write the file into the project again"
                    onClick={() =>
                      void trackMediaTask(
                        { projectId, taskId: task.id, destPath: task.destPath, kind: task.kind },
                        { force: true },
                      )
                    }
                  >
                    Re-save
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
