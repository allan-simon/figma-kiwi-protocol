#!/usr/bin/env node
// Palier 4-bis recon — extract everything needed to open our own Figma multiplayer
// WebSocket from Node, without riding on top of the user's Chrome session.
//
// Captures Network.webSocketCreated + webSocketWillSendHandshakeRequest +
// webSocketHandshakeResponseReceived events around a Figma page reload, plus
// the cookies for figma.com. Output:
//   /tmp/figma_handshake.json   { wsUrl, requestHeaders, responseHeaders, cookies }
//
// Usage:
//   CDP_WS_URL="ws://172.17.0.1:9223/devtools/browser/<id>" \
//   node bin/recon-handshake.mjs --match biblioth

import { writeFileSync } from 'fs';

const wsUrl = process.env.CDP_WS_URL;
if (!wsUrl) { console.error('Set CDP_WS_URL'); process.exit(1); }

const argv = process.argv.slice(2);
const matchIdx = argv.indexOf('--match');
const urlMatch = matchIdx >= 0 ? argv[matchIdx + 1]?.toLowerCase() : null;

const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
const targets = await fetch(`${httpBase}/json`).then(r => r.json());
const tab = targets.find(t =>
  t.url?.includes('figma.com/design') &&
  (!urlMatch || t.url.toLowerCase().includes(urlMatch))
);
if (!tab) { console.error('No matching Figma tab'); process.exit(1); }
console.error(`Target: ${tab.title}`);

const pageWs = new WebSocket(tab.webSocketDebuggerUrl);
let id = 1;
const inflight = new Map();
function cdp(method, params = {}) {
  const i = id++;
  pageWs.send(JSON.stringify({ id: i, method, params }));
  return new Promise((resolve, reject) => inflight.set(i, { resolve, reject }));
}

// We track every WebSocket created during the recon window, and pick the one whose
// URL hosts a Figma multiplayer endpoint (it's not the only WS — there are presence,
// LiveGraph, etc — but the multiplayer one is the only one we care about for writes).
const sockets = new Map(); // requestId → { url, requestHeaders, responseHeaders, frames: {sentBin, recvBin, sentText, recvText} }
function getSock(reqId) {
  if (!sockets.has(reqId)) sockets.set(reqId, { url: null, requestHeaders: null, responseHeaders: null, frames: { sentBin: 0, recvBin: 0, sentText: 0, recvText: 0 } });
  return sockets.get(reqId);
}

pageWs.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && inflight.has(m.id)) {
    const { resolve, reject } = inflight.get(m.id);
    inflight.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
    return;
  }
  if (m.method === 'Network.webSocketCreated') {
    const s = getSock(m.params.requestId);
    s.url = m.params.url;
    if (m.params.initiator) s.initiator = m.params.initiator;
  }
  if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
    const s = getSock(m.params.requestId);
    s.requestHeaders = m.params.request?.headers;
  }
  if (m.method === 'Network.webSocketHandshakeResponseReceived') {
    const s = getSock(m.params.requestId);
    s.responseHeaders = m.params.response?.headers;
  }
  if (m.method === 'Network.webSocketFrameReceived') {
    const s = getSock(m.params.requestId);
    if (m.params.response?.opcode === 2) s.frames.recvBin++; else s.frames.recvText++;
  }
  if (m.method === 'Network.webSocketFrameSent') {
    const s = getSock(m.params.requestId);
    if (m.params.response?.opcode === 2) s.frames.sentBin++; else s.frames.sentText++;
  }
});

await new Promise((res, rej) => {
  pageWs.addEventListener('open', res, { once: true });
  pageWs.addEventListener('error', rej, { once: true });
});

await cdp('Network.enable');
await cdp('Page.enable');

// Pull cookies BEFORE we touch the page — they're stable
const cookieRes = await cdp('Network.getAllCookies');
const figmaCookies = (cookieRes.cookies || []).filter(c => /figma\.com$/.test(c.domain) || c.domain === 'figma.com' || c.domain === '.figma.com');
console.error(`Captured ${figmaCookies.length} figma.com cookies (out of ${cookieRes.cookies?.length || 0} total).`);

console.error('Reloading page to observe a fresh handshake...');
const loadFired = new Promise((res) => {
  const h = (ev) => {
    const x = JSON.parse(ev.data);
    if (x.method === 'Page.loadEventFired') { pageWs.removeEventListener('message', h); res(); }
  };
  pageWs.addEventListener('message', h);
});
await cdp('Page.reload', { ignoreCache: false });
await Promise.race([loadFired, new Promise(r => setTimeout(r, 15000))]);
console.error('Page loaded. Waiting 5s to let WebSockets settle...');
await new Promise(r => setTimeout(r, 5000));

console.error(`\n=== ${sockets.size} WebSocket(s) observed ===`);
for (const [reqId, s] of sockets) {
  console.error(`\n[${reqId}]`);
  console.error(`  url: ${s.url}`);
  console.error(`  frames: sent ${s.frames.sentBin}b/${s.frames.sentText}t  recv ${s.frames.recvBin}b/${s.frames.recvText}t`);
  if (s.requestHeaders) {
    const interesting = ['Origin','Sec-WebSocket-Protocol','User-Agent','Cookie','Authorization','X-Figma-Token'];
    for (const k of Object.keys(s.requestHeaders)) {
      const ki = interesting.find(i => i.toLowerCase() === k.toLowerCase());
      if (ki) {
        const v = s.requestHeaders[k];
        const display = k.toLowerCase() === 'cookie' ? `<${v.length} chars, ${v.split(';').length} cookies>` : v.slice(0, 120);
        console.error(`  req[${k}] = ${display}`);
      }
    }
  }
}

const out = {
  capturedAt: new Date().toISOString(),
  tab: { title: tab.title, url: tab.url },
  sockets: [...sockets.entries()].map(([reqId, s]) => ({
    requestId: reqId,
    url: s.url,
    initiator: s.initiator,
    requestHeaders: s.requestHeaders,
    responseHeaders: s.responseHeaders,
    frameStats: s.frames,
  })),
  cookies: figmaCookies,
};
const outPath = '/tmp/figma_handshake.json';
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nSaved: ${outPath}`);

pageWs.close();
