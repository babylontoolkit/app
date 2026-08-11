import{P as R,u as U,s as k}from"./nodepod-BF9GFyQX.js";import{D as $,M as F,N as W,a as I,b as J,c as q,d as G,e as V,R as z,g as K,f as X,i as Z,r as Q,h as Y}from"./nodepod-BF9GFyQX.js";import{existsSync as h,readFileSync as y}from"node:fs";import{join as d,dirname as ee}from"node:path";import{fileURLToPath as w}from"node:url";import{Worker as re}from"node:worker_threads";import te from"node:http";import{createHash as se}from"node:crypto";import{mkdir as oe,readdir as ne,readFile as b,unlink as N,writeFile as P}from"node:fs/promises";import{tmpdir as ae}from"node:os";function ie(){return`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
if (!parentPort) throw new Error("nodepod worker shim: missing parentPort");

const messageListeners = new Set();
const errorListeners = new Set();

function emitMessage(data) {
  const ev = { data };
  for (const fn of messageListeners) {
    try { fn(ev); } catch (err) { console.error(err); }
  }
  if (typeof globalThis.onmessage === "function") {
    try { globalThis.onmessage(ev); } catch (err) { console.error(err); }
  }
}

globalThis.self = globalThis;
globalThis.postMessage = function postMessage(data, transfer) {
  if (Array.isArray(transfer) && transfer.length) {
    parentPort.postMessage(data, transfer);
  } else {
    parentPort.postMessage(data);
  }
};
globalThis.addEventListener = function addEventListener(type, fn) {
  if (type === "message") messageListeners.add(fn);
  else if (type === "error") errorListeners.add(fn);
};
globalThis.removeEventListener = function removeEventListener(type, fn) {
  if (type === "message") messageListeners.delete(fn);
  else if (type === "error") errorListeners.delete(fn);
};
globalThis.onmessage = null;
globalThis.onerror = null;

parentPort.on("message", function (data) { emitMessage(data); });
parentPort.on("error", function (err) {
  const ev = { message: err && err.message ? err.message : String(err), error: err };
  for (const fn of errorListeners) {
    try { fn(ev); } catch (_) { /* ignore */ }
  }
  if (typeof globalThis.onerror === "function") {
    try { globalThis.onerror(ev); } catch (_) { /* ignore */ }
  }
});

const source = workerData && workerData.__nodepodSource;
if (typeof source !== "string" || !source) {
  throw new Error("nodepod worker shim: missing __nodepodSource");
}
(0, eval)(source);
`}function ce(r){const n=new Set,a=new Set;let i=null,t=null;return r.on("message",e=>{const s={data:e};for(const f of n)try{f(s)}catch{}if(i)try{i(s)}catch{}}),r.on("error",e=>{const s={message:e.message,error:e};for(const f of a)try{f(s)}catch{}if(t)try{t(s)}catch{}}),{postMessage(e,s){s&&s.length?r.postMessage(e,s):r.postMessage(e)},terminate(){r.terminate()},addEventListener(e,s){e==="message"?n.add(s):e==="error"&&a.add(s)},removeEventListener(e,s){e==="message"?n.delete(s):e==="error"&&a.delete(s)},get onmessage(){return i},set onmessage(e){i=e},get onerror(){return t},set onerror(e){t=e}}}function _(r,n){const a=new re(ie(),{eval:!0,workerData:{__nodepodSource:r},...n?{name:n}:{}});return ce(a)}function C(r){const n=r.host??"127.0.0.1",a=r.port??0;let i=null,t=null;async function e(c){const o=[];for await(const l of c)o.push(Buffer.isBuffer(l)?l:Buffer.from(l));return Buffer.concat(o)}function s(c){const o={};for(const[l,u]of Object.entries(c))u!=null&&(o[l]=Array.isArray(u)?u.join(", "):u);return o}async function f(c,o){try{const l=new URL(c.url||"/",`http://${n}`),u=l.pathname.split("/").filter(Boolean);if(u[0]!=="__virtual__"||u.length<3){o.statusCode=404,o.setHeader("Content-Type","text/plain"),o.end("Not Found");return}const x=u[1],L=Number(u[2]);if(!Number.isFinite(L)){o.statusCode=400,o.setHeader("Content-Type","text/plain"),o.end("Invalid port");return}const m=await e(c),O=m.byteLength>0?m.buffer.slice(m.byteOffset,m.byteOffset+m.byteLength):void 0,v=u.slice(3),j=(v.length?`/${v.join("/")}`:"/")+l.search,p=await r.proxy.handleRequest(x,L,(c.method||"GET").toUpperCase(),j,s(c.headers),O);o.statusCode=p.statusCode;for(const[M,g]of Object.entries(p.headers))g!=null&&(Array.isArray(g),o.setHeader(M,g));const A=p.body?Buffer.isBuffer(p.body)?p.body:Buffer.from(p.body):Buffer.alloc(0);o.end(A)}catch(l){o.statusCode=500,o.setHeader("Content-Type","text/plain"),o.end(l instanceof Error?l.message:String(l))}}return{kind:"local-http",get baseUrl(){return t},async start(){if(i)return;i=te.createServer((o,l)=>{f(o,l)}),await new Promise((o,l)=>{i.once("error",l),i.listen(a,n,()=>{i.off("error",l),o()})});const c=i.address();c&&typeof c=="object"?t=`http://${n}:${c.port}`:t=`http://${n}`,r.proxy.setBaseUrl(t)},async stop(){const c=i;i=null,t=null,c&&await new Promise(o=>{c.close(()=>o())})}}}const S=2,E=7*24*60*60*1e3;function fe(){return process.env.NODEPOD_CACHE||d(ae(),"nodepod-snapshots")}function T(r,n){const a=se("sha256").update(n).digest("hex");return d(r,`${a}.bin`)}async function B(r=fe()){try{await oe(r,{recursive:!0})}catch{return null}return(async()=>{try{const n=await ne(r),a=Date.now();for(const i of n)if(i.endsWith(".meta.json"))try{const t=await b(d(r,i),"utf8"),e=JSON.parse(t);if(e.schema!==S||e.createdAt!=null&&a-e.createdAt>E){const s=i.slice(0,-10);await N(d(r,i)).catch(()=>{}),await N(d(r,`${s}.bin`)).catch(()=>{})}}catch{}}catch{}})(),{async get(n){try{const a=T(r,n),i=a.replace(/\.bin$/,".meta.json"),t=await b(i,"utf8"),e=JSON.parse(t);if(e.schema!==S||e.createdAt!=null&&Date.now()-e.createdAt>E)return null;const s=await b(a);if(s.byteLength<4)return null;const f=s.readUInt32LE(0),c=s.subarray(4,4+f),o=s.buffer.slice(s.byteOffset+4+f,s.byteOffset+s.byteLength);return{manifest:JSON.parse(c.toString("utf8")),data:o}}catch{return null}},async set(n,a){const i=T(r,n),t=i.replace(/\.bin$/,".meta.json"),e=Buffer.from(JSON.stringify(a.manifest),"utf8"),s=Buffer.from(a.data),f=Buffer.alloc(4);f.writeUInt32LE(e.byteLength,0),await P(i,Buffer.concat([f,e,s])),await P(t,JSON.stringify({schema:S,createdAt:Date.now()}))},close(){}}}function D(){try{const r=ee(w(import.meta.url)),n=[d(r,"..","..","__worker__.js"),d(r,"..","..","..","dist","__worker__.js"),d(process.cwd(),"dist","__worker__.js")];for(const a of n)if(h(a))return a}catch{}return null}function le(){const r=Buffer.from(R,"base64");return U(r,{to:"string"})}function ue(r,n){return!n&&r&&h(r)?y(r,"utf8"):r&&h(r)?y(r,"utf8"):le()}function H(r={}){let n=r.workerPath??D(),a=null;function i(t){if(!t&&a)return a;const e=ue(n,!!t);return t||(a=e),e}return{kind:"node",defaultHeadless:!0,canCreateWorkers(){return!0},createWorker(t){if(t.type==="url"){let f=t.url;if(f.startsWith("file:")&&(f=w(f)),!h(f))throw new Error(`[Nodepod] Node host cannot load worker URL: ${t.url}`);const c=y(f,"utf8"),o=_(c,t.name);return o.__nodepodDirect=!0,o}if(t.type==="source")return _(t.source,t.name);const e=i(t.embedded),s=_(e,t.name);return n&&!t.embedded&&(s.__nodepodDirect=!0),s},async probeProcessWorkerUrl(t){if(t){let s=t;return s.startsWith("file:")&&(s=w(s)),h(s)?(n=s,a=null,s):null}const e=D();return e?(n=e,a=null,e):null},disposeGlobalResources(){a=null},async openSnapshotCache(t){return t.enableSnapshotCache===!1||t.packageStore==="memory"?null:B(r.cacheDir)},createHttpIngress({proxy:t,headless:e}){return e?C({proxy:t,host:r.httpHost,port:r.httpPort}):{kind:"programmatic",baseUrl:null}}}}k(H());export{$ as DependencyInstaller,F as MemoryVolume,W as Nodepod,I as NodepodFS,J as NodepodFSClient,q as NodepodFSClientError,G as NodepodProcess,V as NodepodSWSetupError,z as RequestProxy,C as createLocalHttpIngress,H as createNodeHost,K as getProxyInstance,X as getRuntimeHost,Z as install,B as openFsSnapshotCache,Q as resetProxy,Y as resetRuntimeHost,k as setRuntimeHost};
