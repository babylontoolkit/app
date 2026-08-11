const PID = 'prj_20260811045242_ga5znrpy';
const url = `http://localhost:5173/api/projects/${PID}/media`;
const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.text() }));

// The tool schema's DEFAULTS, exactly as generate_image / generate_video use them.
console.log('--- image default (nano-banana-2) ---');
console.log(JSON.stringify(await post({ action: 'quote', model: 'nano-banana-2', options: { resolution: '2K', aspectRatio: '16:9' } }), null, 1));
console.log('--- video default (kling-3.0/video) ---');
console.log(JSON.stringify(await post({ action: 'quote', model: 'kling-3.0/video', options: { sound: false, aspectRatio: '16:9', mode: 'std' }, durationSeconds: 5 }), null, 1));
