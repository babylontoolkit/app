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
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { sessionStore } from '~/lib/stores/session';
import {
  hasCutoutPass,
  imageModelCapability,
  supportsTransparency,
  type ImageProviderName,
} from '~/lib/media/image-capabilities';
import { FAL_VIDEO_DURATIONS, defaultFalVideoSeconds, falModelsOfKind } from '~/lib/media/fal-routes';
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
  key:
    | 'resolution'
    | 'mode'
    | 'sound'
    | 'duration'
    | 'aspectRatio'
    | 'outputFormat'
    | 'transparent'
    | 'loop'
    | 'instrumental';
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
export const IMAGE_MODELS: ModelSpec[] = [
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
    ],
  },
  { id: 'nano-banana-2-lite', label: 'Nano Banana 2 Lite', fields: [resolution(['1K'], '1K'), aspect()] },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', fields: [resolution(['1K', '2K', '4K'], '2K'), aspect()] },
  { id: 'seedream/5-pro', label: 'Seedream 5 Pro', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
  { id: 'flux-2/pro', label: 'Flux 2 Pro', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
  { id: 'flux-2/flex', label: 'Flux 2 Flex', fields: [resolution(['1K', '2K'], '2K'), aspect()] },
];

/**
 * 🔴 THE BACKGROUND CONTROL IS DRIVEN BY THE CAPABILITY TABLE, NEVER HAND-ATTACHED.
 *
 * It was once written literally onto one model's field list, which merely AGREED with
 * `image-capabilities.ts` — so adding a model here, or flipping `nativeAlpha` there, would silently
 * desynchronise them and offer transparency a quote then refuses. Deriving it means the table is the
 * only place that answers "can this model do alpha", which is what FR7 asked for ("a per-model
 * capability table, never a flag").
 *
 * KIE is the other half: nothing there emits alpha, but a priced cut-out pass can add it, so the
 * control is offered on the model the KIE list prices for it. `supportsTransparency` answers
 * "can this GATEWAY deliver alpha by any route at all", and the per-model check answers "on this one".
 */
export function withBackgroundField(model: ModelSpec, provider: ImageProviderName | null): ModelSpec {
  if (!provider || !supportsTransparency(provider)) {
    return { ...model, fields: model.fields.filter((f) => f.key !== 'transparent') };
  }

  const native = imageModelCapability(provider, model.id)?.nativeAlpha ?? false;
  const capable = native || hasCutoutPass(provider);

  if (!capable) {
    return { ...model, fields: model.fields.filter((f) => f.key !== 'transparent') };
  }

  if (model.fields.some((f) => f.key === 'transparent')) {
    return model;
  }

  return {
    ...model,
    fields: [
      ...model.fields,
      {
        key: 'transparent',
        label: 'Background',
        choices: [
          { value: 'false', label: native ? 'Opaque' : 'Opaque — JPG' },

          /*
           * The COST is in the label because it differs by model and the user cannot see why: on KIE
           * and fal transparency is a second priced stage; a native-alpha model gets it in the same
           * call. A user who learned one would otherwise be surprised by the other.
           */
          { value: 'true', label: native ? 'Transparent — PNG, no extra cost' : 'Transparent — PNG' },
        ],
        default: 'false',
      },
    ],
  };
}

/**
 * Exported for `media-panel-fields.spec.tsx` only — `modelsForProvider` is the sole runtime reader.
 *
 * The alternative was writing the nine ids into the spec by hand, which asserts that someone typed the
 * same list twice rather than that the function returns THIS catalogue: a model added here and not
 * there would fail the test as a mismatch, teaching the reader to sync the copy instead of to check
 * the mapping. One writer of the list, and the spec points at it.
 */
export const VIDEO_MODELS: ModelSpec[] = [
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

/**
 * fal.ai's catalogue (`_specs/media-gateways_plan.md` T3) — built FROM `fal-routes.ts`, the table the
 * service submits through, so the panel can never offer a fal model or a clip length the server has no
 * request shape for. The quote is still the referee for price.
 *
 * Image fields follow the price rows: Nano Banana is priced by resolution, Seedream 4.5 is one flat
 * price (its size comes from the aspect). Video: Kling and Veo price on audio on/off, Grok on
 * resolution. The Veo rows are labelled as Google and none is a default — Veo is chosen, never fallen back to.
 */
const FAL_IMAGE_FIELDS: Record<string, FieldSpec[]> = {
  'image-nano': [resolution(['1K', '2K', '4K'], '2K'), aspect()],
  'image-seedream': [aspect()],
};

export const FAL_IMAGE_MODELS: ModelSpec[] = falModelsOfKind('image').map(({ id, route }) => ({
  id,
  label: route.label,
  fields: FAL_IMAGE_FIELDS[route.family] ?? [aspect()],
}));

/** The panel's clip lengths per fal video family — a short, readable subset of what the family renders. */
const FAL_PANEL_SECONDS: Record<keyof typeof FAL_VIDEO_DURATIONS, number[]> = {
  'video-kling': [5, 10],
  'video-grok': [5, 10],
  'video-veo': [...FAL_VIDEO_DURATIONS['video-veo']],
};

const FAL_VIDEO_FIELDS: Record<keyof typeof FAL_VIDEO_DURATIONS, FieldSpec[]> = {
  'video-kling': [
    sound,
    duration(FAL_PANEL_SECONDS['video-kling'], defaultFalVideoSeconds('video-kling')),
    aspect(ASPECTS.slice(0, 3)),
  ],
  'video-grok': [
    resolution(['480p', '720p'], '720p'),
    duration(FAL_PANEL_SECONDS['video-grok'], defaultFalVideoSeconds('video-grok')),
    aspect(),
  ],
  'video-veo': [
    sound,
    duration(FAL_PANEL_SECONDS['video-veo'], defaultFalVideoSeconds('video-veo')),
    aspect(ASPECTS.slice(0, 2)),
  ],
};

export const FAL_VIDEO_MODELS: ModelSpec[] = falModelsOfKind('video').map(({ id, route }) => ({
  id,
  label: route.label,
  fields: FAL_VIDEO_FIELDS[route.family as keyof typeof FAL_VIDEO_FIELDS] ?? [],
}));

/**
 * Sound (§4.16) — KIE only, because no other gateway serves audio.
 *
 * The three kinds are modelled as MODELS rather than as a second selector, because that is exactly
 * what they are on the wire: each one is a distinct priced row with its own endpoint. It also means
 * the kind dropdown, the per-kind fields and the quote all reuse the machinery already here, instead
 * of this tab growing a parallel set of controls.
 */
export const SOUND_MODELS_SPEC: ModelSpec[] = [
  {
    id: 'suno/generate-sounds',
    label: 'Sound effect (default)',
    fields: [
      {
        key: 'loop',
        label: 'Looping',
        choices: [
          { value: 'false', label: 'One-shot' },
          { value: 'true', label: 'Loopable' },
        ],
        default: 'false',
      },
    ],
  },
  {
    id: 'suno/generate-music',
    label: 'Music track',
    fields: [
      {
        key: 'instrumental',
        label: 'Vocals',
        choices: [
          { value: 'true', label: 'Instrumental' },
          { value: 'false', label: 'With vocals' },
        ],
        default: 'true',
      },
    ],
  },
  { id: 'elevenlabs/text-to-speech-multilingual-v2', label: 'Speech — multilingual v2', fields: [] },
  { id: 'elevenlabs/text-to-speech-turbo-2-5', label: 'Speech — turbo 2.5 (cheaper)', fields: [] },
];

/**
 * The catalogue for a gateway — the ONE place that maps a provider onto a model list.
 *
 * 🔴 `null` RETURNS AN EMPTY LIST, IT DOES NOT MEAN KIE. `null` is *no media gateway on this
 * deployment at all* (`/api/me` reports it when the gateway has no key). A ternary that sent it down
 * the KIE branch would offer nano-banana-2 and kling-3.0 on a box that can serve nothing, refused only
 * at quote time.
 *
 * ⚠️ An empty list is a state the caller must RENDER, not index into. Every `models[0]` on this path
 * is optional-chained for that reason; the panel shows an unavailable card instead of a form.
 */
export function modelsForProvider(kind: 'image' | 'video' | 'audio', provider: ImageProviderName | null): ModelSpec[] {
  if (!provider) {
    return [];
  }

  const models = CATALOGUES[provider][kind];

  return kind === 'image' ? models.map((m) => withBackgroundField(m, provider)) : models;
}

/**
 * Every gateway's catalogue, per tab. A RECORD, not the per-gateway ternaries it replaced:
 * those sent any gateway they had not heard of down the KIE branch, so fal would have offered KIE's
 * models and every quote would have refused. A new gateway must state its lists here or fail to compile.
 *
 * An empty list makes its tab ABSENT (fal has no Sound tab until T6/T7).
 */
const CATALOGUES: Record<ImageProviderName, Record<'image' | 'video' | 'audio', ModelSpec[]>> = {
  KIE: { image: IMAGE_MODELS, video: VIDEO_MODELS, audio: SOUND_MODELS_SPEC },
  FAL: { image: FAL_IMAGE_MODELS, video: FAL_VIDEO_MODELS, audio: [] },
};

interface TaskRow {
  id: string;
  kind: 'image' | 'video' | 'audio';
  model: string;
  prompt: string;
  destPath: string;
  status: 'pending' | 'succeeded' | 'failed';
  credits: number;
  error?: string;
}

/** The request body both quote and start send — one builder so they cannot disagree. */
function buildRequest(
  kind: 'image' | 'video' | 'audio',
  model: ModelSpec,
  values: Record<string, string>,
  prompt: string,
) {
  const options: Record<string, string | number | boolean> = {};
  let durationSeconds: number | undefined;

  for (const field of model.fields) {
    const value = values[field.key] ?? field.default;

    if (field.key === 'duration') {
      durationSeconds = Number(value);
    } else if (
      field.key === 'sound' ||
      field.key === 'transparent' ||
      field.key === 'loop' ||
      field.key === 'instrumental'
    ) {
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
  /*
   * WHICH gateway is serving renders — a rendering hint from `/api/me`, never an authority (the quote
   * is still the referee). It decides which model list is drawn; drawing the wrong one offers models
   * every quote would refuse.
   *
   * 🔴 `null` IS ITS OWN STATE (2026-08-11): *this deployment serves no media at all*. A ternary that
   * drew KIE's catalogue for it offered models no gateway could serve, and the user learned that only
   * when the quote came back refused.
   */
  const { media, loading: sessionLoading } = useStore(sessionStore);
  const mediaProvider = media.provider;
  const imageModels = useMemo(() => modelsForProvider('image', mediaProvider), [mediaProvider]);
  const videoModels = useMemo(() => modelsForProvider('video', mediaProvider), [mediaProvider]);
  const soundModels = useMemo(() => modelsForProvider('audio', mediaProvider), [mediaProvider]);

  /*
   * ONE vocabulary. The task record, the wire and the price list all say `audio`; only the TAB says
   * "Sound". A UI-side `'sound'` would have to be translated at every boundary, and a translation
   * nobody can see is how two spellings of one fact drift apart.
   */
  const [kind, setKind] = useState<'image' | 'video' | 'audio'>('image');
  const [modelId, setModelId] = useState(imageModels[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [credits, setCredits] = useState<number | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const models = kind === 'image' ? imageModels : kind === 'video' ? videoModels : soundModels;
  const model = useMemo(
    (): ModelSpec | undefined => models.find((m) => m.id === modelId) ?? models[0],
    [models, modelId],
  );

  const switchKind = (next: 'image' | 'video' | 'audio') => {
    setKind(next);
    setModelId((next === 'image' ? imageModels : next === 'video' ? videoModels : soundModels)[0]?.id ?? '');
    setValues({});
  };

  /*
   * The gateway can change under a mounted panel (an operator flips `MEDIA_PROVIDER`, or the session
   * simply arrives after first paint — `media.provider` is null until `/api/me` answers). Left alone,
   * `modelId` would keep naming a model the new list does not contain and every quote would refuse.
   */
  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.id === modelId)) {
      setModelId(models[0].id);
      setValues({});
    }
  }, [models, modelId]);

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

    /*
     * No gateway means no model, and quoting one would ask the server to price `undefined`. The panel
     * renders its unavailable card in that state; this effect simply has nothing to do.
     */
    if (!model) {
      return undefined;
    }

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

    /*
     * Unreachable from the rendered form (no model means the unavailable card is shown instead), but
     * a start request is a DEBIT — it does not get to be reached by a path nobody checked.
     */
    if (!model) {
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

  /*
   * No gateway, so there is no form to draw — and drawing one would invite the user to compose a
   * request every quote refuses. AFTER every hook, or this early return changes the hook order
   * between renders (the session arrives async, so both branches really do happen in one mount).
   *
   * ⚠️ Two different sentences, because they are two different facts. `loading` means /api/me has not
   * answered yet and media may well be available a moment from now; a settled `null` means this
   * deployment serves none, which is the operator's to fix and not worth waiting for. Collapsing them
   * would either tell a healthy user their platform has no media, or leave someone staring at a
   * spinner that is never going to resolve — the `mount-source.ts` "said none is not said nothing"
   * rule, one screen up.
   */
  if (!model) {
    return (
      <div
        className="overlay-centered fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={onClose}
      >
        <div
          className="w-[420px] max-w-[92vw] rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor p-4 flex flex-col gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Generate media</h2>
            <button className="i-ph:x text-bolt-elements-textSecondary" onClick={onClose} title="Close" />
          </div>
          <p className="text-xs text-bolt-elements-textSecondary">
            {sessionLoading
              ? 'Checking which image and video models are available…'
              : 'Image and video generation is not available on this deployment — the configured provider serves no renders.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay-centered fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] max-h-[85vh] overflow-y-auto rounded-lg bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Generate media</h2>
          <button className="i-ph:x text-bolt-elements-textSecondary" onClick={onClose} title="Close" />
        </div>

        <div className="flex gap-1 rounded-md border border-bolt-elements-borderColor p-0.5 self-start">
          {/* Sound is absent, not disabled, on a gateway that serves no audio. */}
          {(['image', 'video', ...(soundModels.length > 0 ? (['audio'] as const) : [])] as const).map((k) => (
            <button
              key={k}
              className={
                kind === k
                  ? 'px-3 py-1 text-xs rounded bg-accent-500 text-white'
                  : 'px-3 py-1 text-xs rounded text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2'
              }
              onClick={() => switchKind(k)}
            >
              {k === 'image' ? 'Image' : k === 'video' ? 'Video' : 'Sound'}
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
              : kind === 'video'
                ? 'Describe the video — e.g. "cinematic flythrough of a neon city at night"'
                : model?.id.startsWith('elevenlabs/')
                  ? 'The exact words to speak — e.g. "New lap record!"'
                  : model?.id === 'suno/generate-music'
                    ? 'Describe the track — e.g. "driving synthwave, upbeat, retro arcade"'
                    : 'Describe the sound — e.g. "arcade coin pickup chime, short and bright"'
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
