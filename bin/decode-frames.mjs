#!/usr/bin/env node
// Decode every captured WebSocket frame (sent + recv) for inspection.
//
// Palier 1 of write-support reverse engineering: feed frames marked `sent` into
// the same Kiwi decoder used for received frames. If Figma's schema is symmetric
// (one Message union for both directions), sent frames decode immediately and
// reveal the wire format of mutations.
//
// Reads frame_NNNN_{sent,recv}_*.bin from FIGMA_KIWI_DIR (produced by `capture`)
// and writes frames_decoded.json — an ordered array of {index, dir, size, decoded|error}.
//
// Usage:
//   figma-kiwi-protocol decode-frames
//
// Environment:
//   FIGMA_KIWI_DIR   Directory with captured .bin files (default: /tmp/figma_kiwi)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import {
  isFigWireFrame,
  extractCompressedSchema,
  isZstdCompressed,
} from '../lib/index.mjs';

const require = createRequire(import.meta.url);
const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const DECODER_PATH = `${DIR}/figma_decoder.js`;
const KIWI_REPO = `${DIR}/_kiwi`;

// --- Dependency management (mirrors decode.mjs) ---

function ensureDeps() {
  if (!existsSync(`${KIWI_REPO}/js/cli.ts`)) {
    console.error('Cloning kiwi repo...');
    execSync(`git clone --depth 1 https://github.com/evanw/kiwi.git ${KIWI_REPO}`, { stdio: 'inherit' });
  }
  if (!existsSync(`${DIR}/node_modules/fzstd`)) {
    // Anchor npm with a local package.json — without it, `npm install` walks up
    // parent dirs looking for one and installs there instead (e.g. /tmp/node_modules).
    if (!existsSync(`${DIR}/package.json`)) {
      writeFileSync(`${DIR}/package.json`, '{"name":"figma-kiwi-capture","private":true}\n');
    }
    console.error('Installing fzstd...');
    execSync(`cd ${DIR} && npm install --no-save fzstd`, { stdio: 'inherit' });
  }
}

function loadFzstd() {
  ensureDeps();
  return require(`${DIR}/node_modules/fzstd`);
}

function ensureDecoder() {
  if (existsSync(DECODER_PATH)) return require(DECODER_PATH);

  console.error('Generating Kiwi decoder from schema...');
  ensureDeps();

  // Find any fig-wire frame in the capture (the schema is the same for sent+recv)
  const files = readdirSync(DIR).filter(f => f.endsWith('.bin'));
  let schemaFile = null;
  for (const f of files) {
    const buf = readFileSync(`${DIR}/${f}`);
    if (isFigWireFrame(new Uint8Array(buf))) { schemaFile = `${DIR}/${f}`; break; }
  }
  if (!schemaFile) {
    console.error('No fig-wire schema frame found. Run `figma-kiwi-protocol capture` first.');
    process.exit(1);
  }

  const fzstd = loadFzstd();
  const raw = readFileSync(schemaFile);
  const compressed = extractCompressedSchema(new Uint8Array(raw));
  const schemaBytes = Buffer.from(fzstd.decompress(new Uint8Array(compressed)));
  const schemaBinPath = `${DIR}/schema_raw.bin`;
  writeFileSync(schemaBinPath, schemaBytes);

  execSync(`cd ${KIWI_REPO}/js && npx tsx cli.ts --schema ${schemaBinPath} --js ${DECODER_PATH}`, {
    stdio: 'inherit',
    timeout: 30000,
  });
  console.error(`Decoder generated: ${DECODER_PATH}`);
  return require(DECODER_PATH);
}

// --- Main ---

// frame_NNNN_dir_SIZEb.bin — capture.mjs writes zero-padded indices so this
// lexical sort matches capture order, which we need to interpret request/response pairs.
const FRAME_RE = /^frame_(\d+)_(sent|recv)_(\d+)b\.bin$/;
const frameFiles = readdirSync(DIR)
  .map(f => {
    const m = f.match(FRAME_RE);
    return m ? { file: f, index: Number(m[1]), dir: m[2], size: Number(m[3]) } : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.index - b.index);

if (frameFiles.length === 0) {
  console.error(`No frame_*.bin files in ${DIR}`);
  console.error('Run `figma-kiwi-protocol capture` first (the new format encodes direction in the filename).');
  process.exit(1);
}

const fzstd = loadFzstd();
const Schema = ensureDecoder();

const results = [];
const stats = { sent: { ok: 0, fail: 0, schema: 0 }, recv: { ok: 0, fail: 0, schema: 0 } };

for (const { file, index, dir, size } of frameFiles) {
  const raw = readFileSync(`${DIR}/${file}`);
  const bytes = new Uint8Array(raw);

  if (isFigWireFrame(bytes)) {
    // Schema frame — not a regular Message, skip decode but record presence
    stats[dir].schema++;
    results.push({ index, dir, size, kind: 'schema' });
    continue;
  }

  let data;
  try {
    data = isZstdCompressed(bytes) ? new Uint8Array(fzstd.decompress(bytes)) : bytes;
  } catch (e) {
    stats[dir].fail++;
    results.push({ index, dir, size, error: `zstd: ${e.message?.slice(0, 120)}` });
    continue;
  }

  try {
    const decoded = Schema.decodeMessage(data);
    stats[dir].ok++;
    // Top-level keys are the discriminator we care about — the rest goes verbatim
    // so we can grep frames_decoded.json for mutation-shaped fields.
    results.push({ index, dir, size, topLevelKeys: Object.keys(decoded), decoded });
  } catch (e) {
    stats[dir].fail++;
    results.push({ index, dir, size, error: `decode: ${e.message?.slice(0, 120)}` });
  }
}

console.error(`\nFrames: ${frameFiles.length}`);
console.error(`  RECV  ok=${stats.recv.ok}  fail=${stats.recv.fail}  schema=${stats.recv.schema}`);
console.error(`  SENT  ok=${stats.sent.ok}  fail=${stats.sent.fail}  schema=${stats.sent.schema}`);

// Per-direction key histogram — shows which top-level message variants appear
// where. Asymmetry between sent and recv = the mutation surface we want.
const keyHist = { sent: {}, recv: {} };
for (const r of results) {
  if (!r.topLevelKeys) continue;
  for (const k of r.topLevelKeys) {
    keyHist[r.dir][k] = (keyHist[r.dir][k] || 0) + 1;
  }
}
console.error('\nTop-level keys by direction:');
for (const dir of ['sent', 'recv']) {
  const entries = Object.entries(keyHist[dir]).sort((a, b) => b[1] - a[1]);
  console.error(`  ${dir.toUpperCase()}:`);
  for (const [k, n] of entries) console.error(`    ${k}: ${n}`);
}

const outPath = `${DIR}/frames_decoded.json`;
// JSON.stringify with a replacer to handle Uint8Array → base64 (Kiwi decoders
// produce raw byte arrays for `byte[]` schema fields, which JSON can't serialize natively)
const replacer = (_k, v) => {
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64'), len: v.length };
  // Kiwi maps schema int64/uint64 to JS BigInt — JSON can't serialize natively.
  // We tag as string so palier 2 analysis can still parse + recognize the type.
  if (typeof v === 'bigint') return { __bigint: v.toString() };
  return v;
};
writeFileSync(outPath, JSON.stringify(results, replacer, 2));
console.error(`\nSaved: ${outPath} (${(JSON.stringify(results, replacer).length / 1024).toFixed(0)} KB)`);
