#!/usr/bin/env node
// Fetch the comments list for a Figma file, two ways:
//
//   1. REST API (`/v1/files/:key/comments`) — needs FIGMA_TOKEN with
//      `file_comments:read` scope. Read-only, rate-limited, but no
//      browser dependency.
//   2. Internal endpoint (`/api/file/:key/comments`) — uses an
//      authenticated Figma tab's session cookies, captured via CDP.
//      Same payload as the REST API plus the internal-only fields
//      (`stable_path`, `client_meta.in_frame`, etc.) that drive the
//      in-app pin rendering. Falls back to this when no token is set
//      or the token is rejected.
//
// Usage:
//   FIGMA_TOKEN=figd_...  figma-kiwi comments <file_key>
//   CDP_WS_URL=ws://...    figma-kiwi comments <file_key>          # CDP fallback
//   figma-kiwi comments <file_key> --threads                       # group by parent_id
//   figma-kiwi comments <file_key> --page <page_id>                # filter to one page
//   figma-kiwi comments <file_key> --out comments.json             # write to file
//
// Output: JSON to stdout (or `--out`). With `--threads`, the array
// is the thread roots from `lib/comments.mjs#buildThreads`; without
// it, the raw `meta` array is passed through unchanged.

import { writeFileSync } from 'fs';
import { buildThreads, flattenComment } from '../lib/comments.mjs';

const argv = process.argv.slice(2);
const fileKey = argv.find((a) => !a.startsWith('--'));
if (!fileKey) {
  console.error('Usage: figma-kiwi comments <file_key> [--threads] [--page <id>] [--out <path>] [--flat]');
  process.exit(1);
}

const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const wantThreads = flag('--threads');
const wantFlat = flag('--flat');
const pageFilter = opt('--page');
const outPath = opt('--out');

const payload = await fetchComments(fileKey);
let comments = payload?.meta ?? payload?.comments ?? payload ?? [];

if (pageFilter) {
  comments = comments.filter((c) => (c.client_meta?.page_id ?? null) === pageFilter);
}

let result;
if (wantThreads) {
  result = buildThreads(comments).map((t) => ({
    ...(wantFlat ? flattenComment(t) : t),
    replies: (t.replies || []).map((r) => (wantFlat ? flattenComment(r) : r)),
  }));
} else if (wantFlat) {
  result = comments.map(flattenComment);
} else {
  result = comments;
}

const json = JSON.stringify(result, null, 2);
if (outPath) writeFileSync(outPath, json);
else console.log(json);

// ------------------------------------------------------------------

async function fetchComments(key) {
  const token = process.env.FIGMA_TOKEN;
  if (token) {
    const r = await fetch(`https://api.figma.com/v1/files/${key}/comments`, {
      headers: { 'X-Figma-Token': token },
    });
    if (r.ok) return await r.json();
    const body = await r.text();
    if (r.status !== 401 && r.status !== 403) {
      throw new Error(`REST comments fetch failed: ${r.status} ${body.slice(0, 200)}`);
    }
    console.error(`REST API rejected token (${r.status}); falling back to CDP.`);
  }

  const wsUrl = process.env.CDP_WS_URL;
  if (!wsUrl) {
    throw new Error(
      'No FIGMA_TOKEN with file_comments:read scope, and no CDP_WS_URL fallback. ' +
        'Set one of them.',
    );
  }
  return await fetchViaCdp(wsUrl, key);
}

// Pick a logged-in Figma tab from CDP and run a same-origin fetch from
// inside it — Figma's internal endpoint trusts the session cookies the
// browser already carries, so no token plumbing is needed. The same
// trick powers the image-batch lookup documented in the skill README.
async function fetchViaCdp(wsUrl, key) {
  const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
  const res = await fetch(`${httpBase}/json`);
  const targets = await res.json();
  const tab = targets.find((t) => t.url?.includes('figma.com/'));
  if (!tab) throw new Error('No Figma tab found in CDP target list.');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));

  const expr = `
    (async () => {
      const r = await fetch('/api/file/${key}/comments?file_id=${key}&include_resolved=true', {credentials: 'same-origin'});
      const t = await r.text();
      return {status: r.status, body: t};
    })()
  `;

  const result = await new Promise((resolve, reject) => {
    let id = 1;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) resolve(msg.result);
    });
    ws.send(JSON.stringify({
      id: id++,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }));
    setTimeout(() => reject(new Error('CDP eval timed out')), 15_000);
  });

  ws.close();

  const inner = result?.result?.value;
  if (!inner) throw new Error(`CDP fetch returned no value: ${JSON.stringify(result).slice(0, 200)}`);
  if (inner.status !== 200) {
    throw new Error(`Figma /api/file/${key}/comments returned ${inner.status}: ${inner.body.slice(0, 200)}`);
  }
  return JSON.parse(inner.body);
}
