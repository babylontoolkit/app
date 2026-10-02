/**
 * Comet audio probe (`node scripts/comet-audio-probe.mjs [only-job-names,...]`).
 *
 * Answers what Comet's SOUND routes actually do — the questions `_specs/media-gateways_plan.md` T1
 * baked prices around without being able to check, because `COMET_API_KEY` was blank when the rows
 * were written (2026-10-01):
 *
 *  - does a sound-effect `duration` scale the charge (per second) or not (per request)? The feed
 *    says per request; the probe submits the same prompt at 2 s and with no duration;
 *  - which statuses do the RunwayML-style task routes report, in what order, and does a fresh task
 *    really answer 400 `task_not_exist` before it is visible;
 *  - how many clips one Suno submit returns, and which `mv` value works;
 *  - where the result files live, whether they download WITHOUT the bearer key, and what they are
 *    (Content-Type plus a decode of the first bytes — never the extension);
 *  - latency, and the charge (balance before and after, when the account endpoint answers).
 *
 * Sibling of `fal-media-probe.mjs`, `cache-probe.mjs` and `kie-model-health.mjs`: a committed command,
 * because the answers move when the vendor does. Never prints the key; raw output goes to
 * `PROBE_OUT_DIR` (default: the OS temp dir), never into the repo.
 *
 * It spends real money: about $0.20 (two sound effects, one ~60-character speech line, one Suno
 * instrumental). Pass job names to run a subset: `node scripts/comet-audio-probe.mjs sfx-2s,speech`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const KEY = env.COMET_API_KEY;

if (!KEY) {
  console.error('COMET_API_KEY is not set in .env.local — nothing was submitted.');
  process.exit(1);
}

/*
 * The audio routes are NOT under `/v1`, so the host is derived from the configured base URL rather
 * than appended to it (the same rule the platform client follows).
 */
const HOST = new URL(env.COMET_BASE_URL || 'https://api.cometapi.com/v1').origin;
const AUTH = { Authorization: `Bearer ${KEY}` };
const OUT = process.env.PROBE_OUT_DIR || join(tmpdir(), `comet-audio-probe-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const POLL_MS = 3000;
const DEADLINE_MS = 10 * 60_000;

/** `mv` values to try for Suno, newest first — the first one the submit accepts is recorded. */
const SUNO_MV = ['chirp-v5', 'chirp-v4-5', 'chirp-v4'];

const JOBS = [
  {
    name: 'sfx-2s',
    kind: 'runway',
    path: '/runwayml/v1/sound_effect',
    body: { model: 'eleven_text_to_sound_v2', promptText: 'A short arcade coin pickup chime', duration: 2 },
  },
  {
    name: 'sfx-auto',
    kind: 'runway',
    path: '/runwayml/v1/sound_effect',
    body: { model: 'eleven_text_to_sound_v2', promptText: 'A short arcade coin pickup chime' },
  },
  {
    name: 'speech',
    kind: 'runway',
    path: '/runwayml/v1/text_to_speech',
    body: {
      model: 'eleven_multilingual_v2',
      promptText: 'Welcome back, racer. Your next track is ready to go!',
      voice: { type: 'runway-preset', presetId: 'Maya' },
    },
  },
  { name: 'music', kind: 'suno' },
];

const only = process.argv[2]?.split(',').filter(Boolean);
const selected = only ? JOBS.filter((j) => only.includes(j.name)) : JOBS;

async function readBody(res) {
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

function magicOf(bytes) {
  const b = bytes;
  const hex = Buffer.from(b.slice(0, 16)).toString('hex');
  const ascii = (from, to) => Buffer.from(b.slice(from, to)).toString();

  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return { hex, kind: 'MP3' };
  }

  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') {
    return { hex, kind: 'WAV' };
  }

  if (ascii(4, 8) === 'ftyp') {
    return { hex, kind: `MP4/M4A (${ascii(8, 12)})` };
  }

  if (ascii(0, 4) === 'OggS') {
    return { hex, kind: 'OGG' };
  }

  if (ascii(0, 4) === 'fLaC') {
    return { hex, kind: 'FLAC' };
  }

  return { hex, kind: 'unknown' };
}

async function inspectFile(name, url) {
  const record = { url, host: new URL(url).host };
  const res = await fetch(url); // deliberately WITHOUT the key
  record.downloadWithoutKeyHttp = res.status;
  record.contentType = res.headers.get('content-type');

  if (res.ok) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    record.bytes = bytes.length;
    record.magic = magicOf(bytes);
    writeFileSync(join(OUT, `${name}.${record.magic.kind.split(/[ /]/)[0].toLowerCase()}`), bytes);
  } else {
    const keyed = await fetch(url, { headers: AUTH });
    record.downloadWithKeyHttp = keyed.status;
  }

  return record;
}

async function poll(url, statusOf) {
  const sequence = [];
  const t0 = Date.now();
  let last;

  while (Date.now() - t0 < DEADLINE_MS) {
    const res = await fetch(url, { headers: AUTH });
    last = { http: res.status, body: await readBody(res) };

    const status = statusOf(last);

    if (sequence.at(-1) !== status) {
      sequence.push(status);
    }

    if (/^(SUCCEEDED|FAILED|CANCELLED|SUCCESS|FAILURE|complete|error)$/i.test(status)) {
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return { sequence, last };
}

async function runRunway(job) {
  const record = { name: job.name, path: job.path, body: job.body };
  const t0 = Date.now();
  const submit = await fetch(`${HOST}${job.path}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(job.body),
  });
  record.submitHttp = submit.status;
  record.submitBody = await readBody(submit);

  const id = record.submitBody?.id;

  if (!submit.ok || !id) {
    record.outcome = 'refused at submit';
    return record;
  }

  const { sequence, last } = await poll(
    `${HOST}/runwayml/v1/tasks/${id}`,
    ({ http, body }) =>
      body?.status ??
      (body?.code === 'task_not_exist' || /task_not_exist/.test(JSON.stringify(body))
        ? `HTTP ${http} task_not_exist`
        : `HTTP ${http}`),
  );
  record.statusSequence = sequence;
  record.finalBody = last?.body;
  record.latencyMs = Date.now() - t0;

  const outputs = Array.isArray(last?.body?.output) ? last.body.output : [];
  record.files = [];

  for (const [i, url] of outputs.entries()) {
    if (typeof url === 'string') {
      record.files.push(await inspectFile(`${job.name}-${i}`, url));
    }
  }

  record.outcome = record.files.length ? 'delivered' : 'no file';

  return record;
}

async function runSuno(job) {
  const record = { name: job.name, attempts: [] };
  const t0 = Date.now();
  let taskId = null;

  for (const mv of SUNO_MV) {
    const body = {
      prompt: '',
      tags: 'chiptune, upbeat, racing, 8-bit arcade',
      title: 'Probe Theme',
      mv,
      make_instrumental: true,
      generation_type: 'TEXT',
      metadata: { create_mode: 'custom' },
    };
    const submit = await fetch(`${HOST}/suno/submit/music`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await readBody(submit);
    record.attempts.push({ mv, http: submit.status, body: parsed });

    if (submit.ok && typeof parsed?.data === 'string') {
      taskId = parsed.data;
      record.mvThatWorked = mv;
      break;
    }
  }

  if (!taskId) {
    record.outcome = 'refused at submit';
    return record;
  }

  const { sequence, last } = await poll(
    `${HOST}/suno/fetch/${taskId}`,
    ({ http, body }) => body?.data?.status ?? `HTTP ${http}`,
  );
  record.statusSequence = sequence;
  record.finalBody = last?.body;
  record.latencyMs = Date.now() - t0;

  const clips = Array.isArray(last?.body?.data?.data) ? last.body.data.data : [];
  record.clipCount = clips.length;
  record.files = [];

  for (const [i, clip] of clips.entries()) {
    if (typeof clip?.audio_url === 'string') {
      record.files.push({ ...(await inspectFile(`music-${i}`, clip.audio_url)), duration: clip.duration });
    }
  }

  record.outcome = record.files.length ? 'delivered' : 'no file';

  return record;
}

async function balance() {
  /* Best effort — the account endpoint is not part of the documented media API. */
  try {
    const res = await fetch(`${HOST}/api/user/self`, { headers: AUTH });
    return { http: res.status, body: await readBody(res) };
  } catch (error) {
    return { error: String(error) };
  }
}

async function main() {
  console.log(`Comet audio probe — ${selected.length} jobs, raw output → ${OUT}`);

  const before = await balance();
  const results = await Promise.all(selected.map((job) => (job.kind === 'suno' ? runSuno(job) : runRunway(job))));
  const after = await balance();

  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), before, after, results }, null, 2),
  );

  console.log('\njob | status sequence | files (magic, key needed) | latency');

  for (const r of results) {
    console.log(
      [
        r.name,
        (r.statusSequence ?? [r.outcome]).join('→'),
        (r.files ?? [])
          .map((f) => `${f.magic?.kind ?? '?'}${f.downloadWithoutKeyHttp === 200 ? '' : ' (KEY NEEDED?)'}`)
          .join(', ') || '-',
        r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : '-',
      ].join(' | '),
    );
  }

  console.log(`\nfull report: ${join(OUT, 'report.json')}`);
}

await main();
