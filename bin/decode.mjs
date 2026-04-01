#!/usr/bin/env node
// Decode captured Figma WebSocket frames into a JSON scenegraph.
// Reads binary .bin files from FIGMA_KIWI_DIR, decompresses zstd,
// decodes via generated Kiwi decoder, merges pages, writes scenegraph.json.
//
// Usage:
//   figma-kiwi decode
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
  mergePages,
  countByType,
  nodeId,
  serializeScenegraph,
} from '../lib/index.mjs';

const require = createRequire(import.meta.url);
const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const DECODER_PATH = `${DIR}/figma_decoder.js`;
const KIWI_REPO = `${DIR}/_kiwi`;

// --- Dependency management ---

function ensureDeps() {
  if (!existsSync(`${KIWI_REPO}/js/cli.ts`)) {
    console.error('Cloning kiwi repo...');
    execSync(`git clone --depth 1 https://github.com/evanw/kiwi.git ${KIWI_REPO}`, { stdio: 'inherit' });
  }
  if (!existsSync(`${DIR}/node_modules/fzstd`)) {
    console.error('Installing fzstd...');
    execSync(`cd ${DIR} && npm install fzstd`, { stdio: 'inherit' });
  }
}

function loadFzstd() {
  ensureDeps();
  return require(`${DIR}/node_modules/fzstd`);
}

function ensureDecoder() {
  if (existsSync(DECODER_PATH)) {
    return require(DECODER_PATH);
  }

  console.error('Generating Kiwi decoder from schema...');
  ensureDeps();

  // Find schema from any fig-wire frame
  const files = readdirSync(DIR).filter(f => f.endsWith('_schema.bin') || f.match(/^frame_0/));
  let schemaFile = null;
  for (const f of files) {
    const path = `${DIR}/${f}`;
    const buf = readFileSync(path);
    if (isFigWireFrame(new Uint8Array(buf))) { schemaFile = path; break; }
  }
  if (!schemaFile) {
    console.error('No fig-wire schema found. Run `figma-kiwi capture` first.');
    process.exit(1);
  }

  // Extract and decompress schema
  const fzstd = loadFzstd();
  const raw = readFileSync(schemaFile);
  const compressed = extractCompressedSchema(new Uint8Array(raw));
  const schemaBytes = Buffer.from(fzstd.decompress(new Uint8Array(compressed)));

  const schemaBinPath = `${DIR}/schema_raw.bin`;
  writeFileSync(schemaBinPath, schemaBytes);

  // Generate JS decoder via kiwi CLI
  execSync(`cd ${KIWI_REPO}/js && npx tsx cli.ts --schema ${schemaBinPath} --js ${DECODER_PATH}`, {
    stdio: 'inherit',
    timeout: 30000,
  });

  console.error(`Decoder generated: ${DECODER_PATH}`);
  return require(DECODER_PATH);
}

// --- Main ---

const dataFiles = readdirSync(DIR).filter(f => f.startsWith('page_') && f.endsWith('_data.bin'));
if (dataFiles.length === 0) {
  console.error(`No page captures found in ${DIR}`);
  console.error('Run `figma-kiwi capture-all-pages` first.');
  process.exit(1);
}

console.error(`Found ${dataFiles.length} page captures`);

const fzstd = loadFzstd();
const Schema = ensureDecoder();

const decodedPages = [];
for (const file of dataFiles) {
  const raw = readFileSync(`${DIR}/${file}`);
  if (raw.length < 100) {
    console.error(`  Skipping ${file} (${raw.length}B — too small)`);
    continue;
  }

  const bytes = new Uint8Array(raw);
  const data = isZstdCompressed(bytes)
    ? new Uint8Array(fzstd.decompress(bytes))
    : bytes;

  try {
    const decoded = Schema.decodeMessage(data);
    const count = decoded.nodeChanges?.length || 0;
    console.error(`  ${file}: ${count} nodes (${(data.length / 1024).toFixed(0)} KB)`);
    decodedPages.push(decoded);
  } catch (e) {
    console.error(`  ${file}: decode failed — ${e.message?.slice(0, 80)}`);
  }
}

const merged = mergePages(decodedPages);
const types = countByType(merged);

console.error(`\nMerged: ${merged.nodeChanges.length} unique nodes`);
console.error('Types:');
for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${t}: ${c}`);
}

const json = serializeScenegraph(merged);
const outPath = `${DIR}/scenegraph.json`;
writeFileSync(outPath, json);
console.error(`\nSaved: ${outPath} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
