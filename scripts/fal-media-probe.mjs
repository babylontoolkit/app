/**
 * fal.ai media probe (`node scripts/fal-media-probe.mjs [only-job-names,...]`).
 *
 * Answers "what does fal's queue REST API ACTUALLY return, and what does it charge?" for every model
 * `_specs/media-gateways_plan.md` puts on the fal gateway — the questions T3's client is written
 * against and that no documentation answers reliably: the relation between `response_url` and
 * `status_url` (the docs say the model's subpath is DROPPED from both), what a failed job looks like
 * (the docs say it still reports `COMPLETED`), which result field holds the file URL per model, whether
 * the file URL needs the key, and whether the transparent cut-out is REALLY transparent.
 *
 * A committed command rather than something re-derived, because the answers move when the vendor does.
 *
 * ## It spends real money
 *
 * About $1.30 at fal's list prices (2026-10-01): three 1K images, one cut-out, a 3 s Kling clip and a
 * 2 s Grok clip with audio off, a 4 s Veo-fast clip with audio off, two short sound effects, two short
 * speech lines and one instrumental song. The two deliberately invalid jobs should cost nothing.
 * Pass job names to run a subset: `node scripts/fal-media-probe.mjs sfx,tts-multi`.
 *
 * ## What it never does
 *
 * - print or write the key (every logged URL and body is the vendor's, never a request header);
 * - set `sync_mode` (that returns the file inline as a data URI — the platform never uses it);
 * - write into the repo — raw outputs land in `PROBE_OUT_DIR` (default: the OS temp dir).
 *
 * ## The cut-out check decodes pixels
 *
 * A PNG container with an alpha channel proves nothing — this platform has shipped RGBA files whose
 * alpha was 255 on every pixel (CLAUDE.md, §4.16). The probe inflates the IDAT stream, un-filters every
 * scanline, and counts the pixels whose alpha is 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      ];
    }),
);

const KEY = env.FAL_API_KEY;

if (!KEY) {
  console.error('FAL_API_KEY is not set in .env.local — nothing was submitted.');
  process.exit(1);
}

const QUEUE = 'https://queue.fal.run';
const API = 'https://api.fal.ai/v1';
const AUTH = { Authorization: `Key ${KEY}` };
const OUT = process.env.PROBE_OUT_DIR || join(tmpdir(), `fal-media-probe-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const POLL_MS = 2500;
const DEADLINE_MS = 12 * 60_000;

/**
 * The jobs. Inputs were read from each model's `https://fal.ai/models/<id>/llms.txt` on 2026-10-01.
 * `veo3` and `kling…/pro` are deliberately absent — same request and result shape as their siblings,
 * at two to four times the price.
 */
const JOBS = [
  {
    name: 'nano-banana-2',
    model: 'fal-ai/nano-banana-2',
    input: {
      prompt: 'A red racing kart emblem on a flat light grey background, clean vector style',
      resolution: '1K',
      aspect_ratio: '1:1',
      output_format: 'jpeg',
      num_images: 1,
    },
  },
  {
    name: 'nano-banana-pro',
    model: 'fal-ai/nano-banana-pro',
    input: { prompt: 'A small wooden treasure chest, game icon', resolution: '1K', aspect_ratio: '1:1', num_images: 1 },
  },
  {
    name: 'seedream-v4.5',

    /* Seedream's smallest size is ~2K (each side 1920–4096); it is priced per image regardless. */
    model: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    input: { prompt: 'A misty pine forest at dawn, painterly game background', image_size: 'auto_2K', num_images: 1 },
  },
  {
    name: 'kling-v3-standard',
    model: 'fal-ai/kling-video/v3/standard/text-to-video',
    input: {
      prompt: 'A paper boat drifting on a calm pond',
      duration: '3',
      generate_audio: false,
      aspect_ratio: '16:9',
    },
  },
  {
    name: 'grok-imagine-video',
    model: 'xai/grok-imagine-video/text-to-video',
    input: { prompt: 'A candle flame flickering in the dark', duration: 2, resolution: '480p', aspect_ratio: '16:9' },
  },
  {
    name: 'veo3-fast',
    model: 'fal-ai/veo3/fast',
    input: {
      prompt: 'A spinning gold coin on a wooden table, close up',
      duration: '4s',
      generate_audio: false,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
  },
  {
    name: 'sfx',
    model: 'fal-ai/elevenlabs/sound-effects/v2',
    input: { text: 'A short arcade coin pickup chime', duration_seconds: 3 },
  },
  {
    name: 'sfx-auto',

    /* No duration: the model chooses one. Answers what a per-second row would have to bill. */
    model: 'fal-ai/elevenlabs/sound-effects/v2',
    input: { text: 'A wooden door creaking open' },
  },
  {
    name: 'tts-multi',
    model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    input: { text: 'Welcome back, racer. Your next track is ready to go!', voice: 'Rachel' },
  },
  {
    name: 'tts-turbo',
    model: 'fal-ai/elevenlabs/tts/turbo-v2.5',
    input: { text: 'Welcome back, racer. Your next track is ready to go!', voice: 'Aria' },
  },
  {
    name: 'music',
    model: 'fal-ai/minimax-music/v2.6',
    input: { prompt: 'Upbeat chiptune racing theme, energetic, 8-bit arcade', is_instrumental: true },
  },
  {
    name: 'invalid-image',

    /* Deliberately invalid: empty prompt + a resolution outside the enum. Captures the failure shape. */
    model: 'fal-ai/nano-banana-2',
    input: { prompt: '', resolution: '9K' },
  },
  {
    name: 'invalid-voice',

    /* Deliberately invalid at RUN time rather than schema time: `voice` is a free string. */
    model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    input: { text: 'This voice does not exist.', voice: 'NotARealVoiceXyz123' },
  },
];

const CUTOUT_MODEL = 'fal-ai/bria/background/remove';

const only = process.argv[2]?.split(',').filter(Boolean);
const selected = only ? JOBS.filter((j) => only.includes(j.name)) : JOBS;
const results = [];

async function readBody(res) {
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

/** The file URL in a result body, and the field that held it. Shapes per the plan's research. */
function fileUrlOf(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  if (Array.isArray(body.images) && body.images[0]?.url) {
    return { field: 'images[0].url', url: body.images[0].url };
  }

  for (const key of ['image', 'video', 'audio', 'audio_file']) {
    const v = body[key];

    if (typeof v === 'string' && /^https?:/.test(v)) {
      return { field: key, url: v };
    }

    if (v && typeof v === 'object' && typeof v.url === 'string') {
      return { field: `${key}.url`, url: v.url };
    }
  }

  return null;
}

function magicOf(bytes) {
  const hex = Buffer.from(bytes.slice(0, 16)).toString('hex');
  const b = bytes;

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { hex, kind: 'PNG' };
  }

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { hex, kind: 'JPEG' };
  }

  if (Buffer.from(b.slice(0, 4)).toString() === 'RIFF' && Buffer.from(b.slice(8, 12)).toString() === 'WEBP') {
    return { hex, kind: 'WEBP' };
  }

  if (Buffer.from(b.slice(4, 8)).toString() === 'ftyp') {
    return { hex, kind: `MP4 (${Buffer.from(b.slice(8, 12)).toString()})` };
  }

  if (Buffer.from(b.slice(0, 3)).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return { hex, kind: 'MP3' };
  }

  if (Buffer.from(b.slice(0, 4)).toString() === 'RIFF' && Buffer.from(b.slice(8, 12)).toString() === 'WAVE') {
    return { hex, kind: 'WAV' };
  }

  if (Buffer.from(b.slice(0, 4)).toString() === 'OggS') {
    return { hex, kind: 'OGG' };
  }

  if (Buffer.from(b.slice(0, 4)).toString() === 'fLaC') {
    return { hex, kind: 'FLAC' };
  }

  return { hex, kind: 'unknown' };
}

/**
 * Decode an 8-bit PNG's alpha and report how much of it is transparent. Handles colour types 6 (RGBA)
 * and 4 (grey+alpha); anything else has no alpha channel at all, which is itself the answer.
 */
function pngAlpha(bytes) {
  const buf = Buffer.from(bytes);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    pos += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];

  if (colorType !== 6 && colorType !== 4) {
    return { width, height, colorType, bitDepth, hasAlphaChannel: false };
  }

  if (bitDepth !== 8 || interlace !== 0) {
    return { width, height, colorType, bitDepth, interlace, note: 'not decoded (only 8-bit non-interlaced)' };
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let transparent = 0;
  let semi = 0;
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;

      if (filter === 1) {
        add = a;
      } else if (filter === 2) {
        add = b;
      } else if (filter === 3) {
        add = (a + b) >> 1;
      } else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }

      line[i] = (line[i] + add) & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const alpha = line[x * bpp + bpp - 1];

      if (alpha === 0) {
        transparent++;
      } else if (alpha < 255) {
        semi++;
      }
    }

    prev = line;
  }

  const total = width * height;

  return {
    width,
    height,
    colorType,
    bitDepth,
    hasAlphaChannel: true,
    fullyTransparentPct: +((100 * transparent) / total).toFixed(2),
    semiTransparentPct: +((100 * semi) / total).toFixed(2),
  };
}

async function runJob(job) {
  const record = { name: job.name, model: job.model, input: job.input };
  const t0 = Date.now();
  const submit = await fetch(`${QUEUE}/${job.model}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(job.input),
  });
  record.submitHttp = submit.status;
  record.submitBody = await readBody(submit);

  if (!submit.ok || typeof record.submitBody !== 'object') {
    record.outcome = 'refused at submit';
    record.latencyMs = Date.now() - t0;
    console.log(`[${job.name}] submit HTTP ${submit.status}`);

    return record;
  }

  const { request_id: id, status_url: statusUrl, response_url: responseUrl } = record.submitBody;
  record.relation = {
    statusIsResponsePlusStatus: statusUrl === `${responseUrl}/status`,
    responseUrlContainsModelPath: responseUrl?.includes(`/${job.model}/requests/`),
    responseUrlPathBeforeRequests: responseUrl?.replace(QUEUE, '').split('/requests/')[0],
  };
  console.log(`[${job.name}] submitted ${id}`);

  /* One result GET BEFORE completion — what does a not-yet-done result look like? */
  const early = await fetch(responseUrl, { headers: AUTH });
  record.earlyResultGet = { http: early.status, body: await readBody(early) };

  const sequence = [];
  let last;

  while (Date.now() - t0 < DEADLINE_MS) {
    const s = await fetch(statusUrl, { headers: AUTH });
    last = { http: s.status, body: await readBody(s) };

    const status = last.body?.status ?? `HTTP ${s.status}`;

    if (sequence.at(-1) !== status) {
      sequence.push(status);
    }

    if (status === 'COMPLETED' || !s.ok) {
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  record.statusSequence = sequence;
  record.finalStatusBody = last?.body;

  const res = await fetch(responseUrl, { headers: AUTH });
  record.resultHttp = res.status;
  record.resultBody = await readBody(res);
  record.latencyMs = Date.now() - t0;

  const file = fileUrlOf(record.resultBody);
  record.fileField = file?.field ?? null;

  if (file) {
    record.fileUrl = file.url;
    record.fileHost = new URL(file.url).host;

    const dl = await fetch(file.url); // deliberately WITHOUT the key
    record.downloadWithoutKeyHttp = dl.status;
    record.contentType = dl.headers.get('content-type');

    if (dl.ok) {
      const bytes = new Uint8Array(await dl.arrayBuffer());
      record.bytes = bytes.length;
      record.magic = magicOf(bytes);

      const ext = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp', MP3: 'mp3', WAV: 'wav', OGG: 'ogg', FLAC: 'flac' }[
        record.magic.kind
      ];
      writeFileSync(join(OUT, `${job.name}.${ext ?? (record.magic.kind.startsWith('MP4') ? 'mp4' : 'bin')}`), bytes);

      if (record.magic.kind === 'PNG') {
        record.alpha = pngAlpha(bytes);
      }
    }
  }

  record.outcome = file ? 'delivered' : 'no file';
  console.log(
    `[${job.name}] ${record.statusSequence.join(' → ')} · result HTTP ${record.resultHttp} · ${record.outcome}`,
  );

  return record;
}

async function main() {
  console.log(`fal media probe — ${selected.length} jobs, raw output → ${OUT}`);

  const cutoutSource = selected.find((j) => j.name === 'nano-banana-2');
  const done = await Promise.all(
    selected.map(async (job) => {
      const r = await runJob(job);
      results.push(r);

      if (job === cutoutSource && r.fileUrl) {
        /* The cut-out runs on the probe's own image output, as the platform's two-stage pass will. */
        results.push(await runJob({ name: 'cutout', model: CUTOUT_MODEL, input: { image_url: r.fileUrl } }));
      }

      return r;
    }),
  );
  void done;

  /* The charge. List prices from the pricing API; actual per-request cost from billing events. */
  const ids = [...new Set([...selected.map((j) => j.model), CUTOUT_MODEL])];
  const pricing = await fetch(`${API}/models/pricing?endpoint_id=${ids.map(encodeURIComponent).join(',')}`, {
    headers: AUTH,
  });
  const pricingBody = await readBody(pricing);

  const requestIds = results.map((r) => r.submitBody?.request_id).filter(Boolean);
  const start = new Date(Date.now() - 2 * 3600_000).toISOString();
  const billing = await fetch(
    `${API}/models/billing-events?start=${encodeURIComponent(start)}&request_id=${requestIds.join(',')}`,
    { headers: AUTH },
  );
  const billingBody = await readBody(billing);

  const report = {
    ranAt: new Date().toISOString(),
    pricing: { http: pricing.status, body: pricingBody },
    billing: { http: billing.status, body: billingBody },
    jobs: results,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\njob | status sequence | result | file field | key needed | magic | latency');

  for (const r of results) {
    console.log(
      [
        r.name,
        (r.statusSequence ?? [r.outcome]).join('→'),
        r.resultHttp ?? r.submitHttp,
        r.fileField ?? '-',
        r.downloadWithoutKeyHttp === undefined
          ? '-'
          : r.downloadWithoutKeyHttp === 200
            ? 'no'
            : `yes? (${r.downloadWithoutKeyHttp})`,
        r.magic?.kind ?? '-',
        `${(r.latencyMs / 1000).toFixed(1)}s`,
      ].join(' | '),
    );
  }

  const cut = results.find((r) => r.name === 'cutout');

  if (cut?.alpha) {
    console.log(`\ncut-out alpha: ${JSON.stringify(cut.alpha)}`);
  }

  console.log(
    `\npricing HTTP ${pricing.status}, billing-events HTTP ${billing.status} — full report: ${join(OUT, 'report.json')}`,
  );
}

await main();
