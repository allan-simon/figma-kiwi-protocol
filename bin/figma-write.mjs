#!/usr/bin/env node
// figma-write — high-level CLI for live Figma mutations.
// Built on lib/session.mjs (FigmaSession) which holds the WebSocket open and
// resolves each command when the server echoes back the matching ackID.
//
// All commands accept guid as "sessionID:localID" (e.g. 2004:16177) and target
// the file from /tmp/figma_handshake.json (re-run recon-handshake first if you
// want to write to a different file).
//
// Commands:
//   rename        <guid> <newName>
//   set-mode      <guid> <VERTICAL|HORIZONTAL|GRID|NONE>
//   enable-al     <guid> [--direction VERTICAL|HORIZONTAL] [--hug both|primary|counter|none]
//                        [--padding N] [--spacing N]
//   disable-al    <guid>
//   hug           <guid> [--axis primary|counter|both]
//   fixed         <guid> [--axis primary|counter|both]
//   padding       <guid> <N>     (or)  <guid> --left N --right N --top N --bottom N
//   spacing       <guid> <N>
//   batch         <file.json>     run a list of mutations sequentially
//
// Common flags:
//   --handshake <path>   default /tmp/figma_handshake.json
//   --kiwi-dir <path>    default /tmp/figma_full_sync
//   --dry-run            print mutations without sending
//   --json               machine-readable output

import { readFileSync } from 'fs';
import { FigmaSession } from '../lib/session.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  return argv[i + 1];
}
function bool(name) { return argv.includes('--' + name); }

if (!cmd || cmd === '--help' || cmd === '-h') {
  process.stderr.write(`figma-write — live Figma mutations via the standalone multiplayer client

Commands:
  rename        <guid> <newName>
  set-mode      <guid> <VERTICAL|HORIZONTAL|GRID|NONE>
  enable-al     <guid> [--direction VERTICAL|HORIZONTAL] [--hug both|primary|counter|none]
                       [--padding N] [--spacing N]
  disable-al    <guid>
  hug           <guid> [--axis primary|counter|both]
  fixed         <guid> [--axis primary|counter|both]
  padding       <guid> <N>     (or use --left/--right/--top/--bottom)
  spacing       <guid> <N>
  batch         <file.json>     run a list of mutations sequentially

Flags:
  --handshake <path>   default /tmp/figma_handshake.json
  --kiwi-dir <path>    default /tmp/figma_full_sync
  --dry-run            print mutations without sending
  --json               machine-readable output
`);
  process.exit(cmd ? 0 : 1);
}

const handshake = flag('handshake', '/tmp/figma_handshake.json');
const kiwiDir = flag('kiwi-dir', '/tmp/figma_full_sync');
const dryRun = bool('dry-run');
const jsonOut = bool('json');

function log(msg) { if (!jsonOut) process.stderr.write(msg + '\n'); }

// Positional args = anything not preceded by a flag and not a flag itself
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { i++; continue; } // skip flag value
  positional.push(argv[i]);
}

async function withSession(fn) {
  log(`Connecting via ${handshake}...`);
  const session = await FigmaSession.connect({ handshakePath: handshake, kiwiDir });
  log(`✓ joined sessionID=${session.sessionID} (lastSeen ackID=${session.lastSeenAckID})`);
  try {
    const result = await fn(session);
    return result;
  } finally {
    await session.close();
    log('connection closed');
  }
}

function reportAck(label, ack) {
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: true, command: label, ackID: ack.ackID, echoedFields: ack.nodeChanges?.[0] ? Object.keys(ack.nodeChanges[0]) : [] }) + '\n');
  } else {
    log(`✓ ${label} acked at ackID=${ack.ackID}`);
  }
}

function dryRunReport(label, mutation) {
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: true, dryRun: true, command: label, mutation }) + '\n');
  } else {
    log(`[dry-run] ${label}: ${JSON.stringify(mutation)}`);
  }
}

// --- command dispatch ---

const handlers = {
  async rename() {
    const [guid, name] = positional;
    if (!guid || !name) throw new Error('usage: rename <guid> <newName>');
    if (dryRun) return dryRunReport('rename', { guid, name });
    return withSession(async (s) => reportAck('rename', await s.rename(guid, name)));
  },

  async 'set-mode'() {
    const [guid, mode] = positional;
    if (!guid || !mode) throw new Error('usage: set-mode <guid> <VERTICAL|HORIZONTAL|GRID|NONE>');
    if (dryRun) return dryRunReport('set-mode', { guid, stackMode: mode });
    return withSession(async (s) => reportAck('set-mode', await s.setStackMode(guid, mode)));
  },

  async 'enable-al'() {
    const [guid] = positional;
    if (!guid) throw new Error('usage: enable-al <guid> [flags]');
    const opts = {
      direction: flag('direction', 'VERTICAL'),
      hug: flag('hug', 'counter'),
    };
    const padding = flag('padding');
    if (padding != null) {
      const p = Number(padding);
      opts.paddingLeft = p; opts.paddingRight = p; opts.paddingTop = p; opts.paddingBottom = p;
    }
    const spacing = flag('spacing');
    if (spacing != null) opts.spacing = Number(spacing);
    if (dryRun) return dryRunReport('enable-al', { guid, ...opts });
    return withSession(async (s) => reportAck('enable-al', await s.enableAutoLayout(guid, opts)));
  },

  async 'disable-al'() {
    const [guid] = positional;
    if (!guid) throw new Error('usage: disable-al <guid>');
    if (dryRun) return dryRunReport('disable-al', { guid, stackMode: 'NONE' });
    return withSession(async (s) => reportAck('disable-al', await s.disableAutoLayout(guid)));
  },

  async hug() {
    const [guid] = positional;
    if (!guid) throw new Error('usage: hug <guid> [--axis primary|counter|both]');
    const axis = flag('axis', 'both');
    const opts = { primary: axis === 'primary' || axis === 'both', counter: axis === 'counter' || axis === 'both' };
    if (dryRun) return dryRunReport('hug', { guid, ...opts });
    return withSession(async (s) => reportAck('hug', await s.setHugContents(guid, opts)));
  },

  async fixed() {
    const [guid] = positional;
    if (!guid) throw new Error('usage: fixed <guid> [--axis primary|counter|both]');
    const axis = flag('axis', 'both');
    const opts = { primary: axis === 'primary' || axis === 'both', counter: axis === 'counter' || axis === 'both' };
    if (dryRun) return dryRunReport('fixed', { guid, ...opts });
    return withSession(async (s) => reportAck('fixed', await s.setFixedSize(guid, opts)));
  },

  async padding() {
    const [guid, num] = positional;
    if (!guid) throw new Error('usage: padding <guid> <N>  OR  padding <guid> --left N --right N --top N --bottom N');
    let value;
    if (num != null) {
      value = Number(num);
    } else {
      value = {};
      const left = flag('left'), right = flag('right'), top = flag('top'), bottom = flag('bottom');
      if (left != null) value.left = Number(left);
      if (right != null) value.right = Number(right);
      if (top != null) value.top = Number(top);
      if (bottom != null) value.bottom = Number(bottom);
      if (Object.keys(value).length === 0) throw new Error('padding: no numeric value or per-side flag given');
    }
    if (dryRun) return dryRunReport('padding', { guid, padding: value });
    return withSession(async (s) => reportAck('padding', await s.setPadding(guid, value)));
  },

  async spacing() {
    const [guid, num] = positional;
    if (!guid || num == null) throw new Error('usage: spacing <guid> <N>');
    const value = Number(num);
    if (dryRun) return dryRunReport('spacing', { guid, stackSpacing: value });
    return withSession(async (s) => reportAck('spacing', await s.setSpacing(guid, value)));
  },

  async batch() {
    const [path] = positional;
    if (!path) throw new Error('usage: batch <file.json>');
    const list = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(list)) throw new Error('batch file must be a JSON array of {command, ...args}');
    log(`batch: ${list.length} mutations from ${path}`);
    return withSession(async (s) => {
      let ok = 0;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const label = `[${i+1}/${list.length}] ${item.command}`;
        try {
          let ack;
          switch (item.command) {
            case 'rename':       ack = await s.rename(item.guid, item.name); break;
            case 'set-mode':     ack = await s.setStackMode(item.guid, item.mode); break;
            case 'enable-al':    ack = await s.enableAutoLayout(item.guid, item.opts || {}); break;
            case 'disable-al':   ack = await s.disableAutoLayout(item.guid); break;
            case 'hug':          ack = await s.setHugContents(item.guid, item.opts || {}); break;
            case 'fixed':        ack = await s.setFixedSize(item.guid, item.opts || {}); break;
            case 'padding':      ack = await s.setPadding(item.guid, item.value); break;
            case 'spacing':      ack = await s.setSpacing(item.guid, item.value); break;
            default: throw new Error(`unknown batch command "${item.command}"`);
          }
          ok++;
          reportAck(label, ack);
        } catch (e) {
          log(`✗ ${label} failed: ${e.message}`);
          if (!bool('continue-on-error')) throw e;
        }
      }
      log(`\nbatch complete: ${ok}/${list.length} succeeded`);
    });
  },
};

const handler = handlers[cmd];
if (!handler) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run figma-write --help for usage');
  process.exit(1);
}

try {
  await handler();
  process.exit(0);
} catch (e) {
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  } else {
    console.error(`✗ ${e.message}`);
  }
  process.exit(2);
}
