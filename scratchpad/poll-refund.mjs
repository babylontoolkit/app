const PID = 'prj_20260811045242_ga5znrpy';
const TID = 'med_mso72eqg_wsv1r0';
const url = `http://localhost:5173/api/projects/${PID}/media/${TID}`;

// Two CONCURRENT polls — the refund-exactly-once path must survive both racing.
const [a, b] = await Promise.all([
  fetch(url).then(async r => ({ status: r.status, body: await r.text() })),
  fetch(url).then(async r => ({ status: r.status, body: await r.text() })),
]);
console.log('poll A:', a.status, a.body.slice(0, 400));
console.log('poll B:', b.status, b.body.slice(0, 400));

// A third, after the fact, to make sure a later poll does not refund again.
const c = await fetch(url).then(async r => ({ status: r.status, body: await r.text() }));
console.log('poll C:', c.status, c.body.slice(0, 400));
