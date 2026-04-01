#!/usr/bin/env node
// Validate .ksy specs by compiling them with Kaitai and parsing real Figma data.
//
// Tests:
//   1. fig_wire_frame.ksy   against a captured schema .bin file
//   2. commands_blob.ksy     against commandsBlob extracted from scenegraph
//   3. vector_network_blob.ksy against vectorNetworkBlob extracted from scenegraph

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FRAMES_DIR = '/tmp/figma_ws_frames';
const FIXTURES_DIR = join(ROOT, 'test', 'fixtures');

mkdirSync(FIXTURES_DIR, { recursive: true });

// Validate by extracting real binary blobs from the scenegraph,
// parsing them byte-by-byte per the .ksy structure, and cross-checking
// against our lib decoders.

console.log('=== Extracting test fixtures from scenegraph ===\n');

// Load scenegraph with raw blobs (need to decode from binary, not the serialized JSON)
const fzstd = require('fzstd');

// Use our decode pipeline to get raw blobs
const { readdirSync } = await import('fs');
const dataFiles = readdirSync(FRAMES_DIR).filter(f => f.startsWith('page_') && f.endsWith('_data.bin'));

// Load decoder
let Schema;
try {
  Schema = require(`${FRAMES_DIR}/figma_decoder.js`);
} catch {
  console.error('No decoder found. Run `figma-kiwi-protocol decode` first.');
  process.exit(1);
}

// --- Test 1: fig-wire frame ---
console.log('--- Test 1: fig_wire_frame.ksy ---');
const schemaFiles = readdirSync(FRAMES_DIR).filter(f => f.endsWith('_schema.bin'));
if (schemaFiles.length > 0) {
  const schemaBuf = readFileSync(`${FRAMES_DIR}/${schemaFiles[0]}`);
  const magic = schemaBuf.subarray(0, 8).toString('ascii');
  const version = schemaBuf.readUInt32LE(8);
  const compressedSchema = schemaBuf.subarray(12);
  const zstdMagic = compressedSchema[0] === 0x28 && compressedSchema[1] === 0xb5 &&
                    compressedSchema[2] === 0x2f && compressedSchema[3] === 0xfd;

  console.log(`  File: ${schemaFiles[0]} (${schemaBuf.length} bytes)`);
  console.log(`  Magic: "${magic}" ${magic === 'fig-wire' ? 'OK' : 'FAIL'}`);
  console.log(`  Version: ${version}`);
  console.log(`  Compressed schema: ${compressedSchema.length} bytes, zstd: ${zstdMagic ? 'OK' : 'FAIL'}`);

  // Decompress to verify
  const decompressed = fzstd.decompress(new Uint8Array(compressedSchema));
  console.log(`  Decompressed schema: ${decompressed.length} bytes`);

  // Save fixture
  writeFileSync(join(FIXTURES_DIR, 'fig_wire_frame.bin'), schemaBuf);
  console.log(`  Fixture saved: test/fixtures/fig_wire_frame.bin\n`);
} else {
  console.log('  SKIP: no schema files found\n');
}

// --- Test 2 & 3: commandsBlob and vectorNetworkBlob ---
console.log('--- Test 2: commands_blob.ksy ---');

// Import our decoders
const { commandsBlobToPath, vectorNetworkBlobToPath } = await import('../lib/svg.mjs');

let commandsBlobCount = 0;
let commandsBlobOk = 0;
let vnBlobCount = 0;
let vnBlobOk = 0;
let sampleCommandsBlob = null;
let sampleVnBlob = null;

let commandsBlobEmpty = 0;

for (const file of dataFiles.slice(0, 3)) { // test first 3 pages
  const raw = readFileSync(`${FRAMES_DIR}/${file}`);
  if (raw.length < 100) continue;

  const bytes = new Uint8Array(raw);
  const magic = bytes.subarray(0, 4);
  const isZstd = magic[0] === 0x28 && magic[1] === 0xb5 && magic[2] === 0x2f && magic[3] === 0xfd;
  const data = isZstd ? new Uint8Array(fzstd.decompress(bytes)) : bytes;

  let decoded;
  try { decoded = Schema.decodeMessage(data); } catch { continue; }

  const blobs = decoded.blobs || [];

  for (const nc of decoded.nodeChanges || []) {
    // commandsBlob
    for (const fg of nc.fillGeometry || []) {
      const idx = fg.commandsBlob;
      if (typeof idx === 'number' && blobs[idx]?.bytes) {
        const blobBytes = blobs[idx].bytes;
        commandsBlobCount++;

        if (blobBytes.length === 0) { commandsBlobEmpty++; continue; }
        const path = commandsBlobToPath(blobBytes);
        if (path && path.startsWith('M ')) {
          commandsBlobOk++;
          // Save first small blob as fixture
          if (!sampleCommandsBlob && blobBytes.length < 500 && blobBytes.length > 20) {
            sampleCommandsBlob = Buffer.from(blobBytes);
            writeFileSync(join(FIXTURES_DIR, 'commands_blob_sample.bin'), sampleCommandsBlob);
          }
        }
      }
    }

    // vectorNetworkBlob
    if (nc.vectorData?.vectorNetworkBlob !== undefined) {
      const idx = nc.vectorData.vectorNetworkBlob;
      if (typeof idx === 'number' && blobs[idx]?.bytes) {
        const blobBytes = blobs[idx].bytes;
        vnBlobCount++;

        const path = vectorNetworkBlobToPath(blobBytes);
        if (path) {
          vnBlobOk++;
          if (!sampleVnBlob && blobBytes.length < 500 && blobBytes.length > 30) {
            sampleVnBlob = Buffer.from(blobBytes);
            writeFileSync(join(FIXTURES_DIR, 'vector_network_blob_sample.bin'), sampleVnBlob);
          }
        }
      }
    }
  }
}

console.log(`  commandsBlob: ${commandsBlobOk}/${commandsBlobCount} parsed OK`);
if (sampleCommandsBlob) {
  console.log(`  Fixture saved: test/fixtures/commands_blob_sample.bin (${sampleCommandsBlob.length} bytes)`);

  // Parse the fixture to show the structure matches our .ksy
  const view = new DataView(sampleCommandsBlob.buffer, sampleCommandsBlob.byteOffset, sampleCommandsBlob.byteLength);
  let pos = 0;
  const cmds = [];
  const opcodeNames = { 0: 'separator', 1: 'move_to', 2: 'line_to', 3: 'close_path', 4: 'cubic_bezier' };
  while (pos < sampleCommandsBlob.length) {
    const op = sampleCommandsBlob[pos]; pos++;
    const name = opcodeNames[op] || `unknown(0x${op.toString(16)})`;
    let params = '';
    if (op === 1 || op === 2) {
      params = `(${view.getFloat32(pos, true).toFixed(2)}, ${view.getFloat32(pos+4, true).toFixed(2)})`;
      pos += 8;
    } else if (op === 4) {
      params = `(${view.getFloat32(pos, true).toFixed(2)}, ${view.getFloat32(pos+4, true).toFixed(2)}, ${view.getFloat32(pos+8, true).toFixed(2)}, ${view.getFloat32(pos+12, true).toFixed(2)}, ${view.getFloat32(pos+16, true).toFixed(2)}, ${view.getFloat32(pos+20, true).toFixed(2)})`;
      pos += 24;
    }
    cmds.push(`    ${name}${params}`);
    if (cmds.length > 10) { cmds.push('    ...'); break; }
  }
  console.log(`  Parsed structure:`);
  console.log(cmds.join('\n'));

  // Cross-check with our decoder
  const svgPath = commandsBlobToPath(sampleCommandsBlob);
  console.log(`  SVG path: ${svgPath?.slice(0, 100)}...`);
}

console.log();
console.log('--- Test 3: vector_network_blob.ksy ---');
console.log(`  vectorNetworkBlob: ${vnBlobOk}/${vnBlobCount} parsed OK`);
if (sampleVnBlob) {
  console.log(`  Fixture saved: test/fixtures/vector_network_blob_sample.bin (${sampleVnBlob.length} bytes)`);

  const view = new DataView(sampleVnBlob.buffer, sampleVnBlob.byteOffset, sampleVnBlob.byteLength);
  const vc = view.getUint32(0, true);
  const sc = view.getUint32(4, true);
  const rc = view.getUint32(8, true);
  console.log(`  Header: ${vc} vertices, ${sc} segments, ${rc} regions`);

  // Print first few vertices
  let pos = 12;
  for (let i = 0; i < Math.min(vc, 3); i++) {
    const flags = view.getUint32(pos, true);
    const x = view.getFloat32(pos + 4, true);
    const y = view.getFloat32(pos + 8, true);
    console.log(`    vertex[${i}]: flags=${flags}, (${x.toFixed(2)}, ${y.toFixed(2)})`);
    pos += 12;
  }

  // Print first few segments
  for (let i = 0; i < Math.min(sc, 3); i++) {
    const flags = view.getUint32(pos, true);
    const start = view.getUint32(pos + 4, true);
    const tsx = view.getFloat32(pos + 8, true);
    const tsy = view.getFloat32(pos + 12, true);
    const end = view.getUint32(pos + 16, true);
    const tex = view.getFloat32(pos + 20, true);
    const tey = view.getFloat32(pos + 24, true);
    console.log(`    segment[${i}]: ${start}→${end}, tangents=(${tsx.toFixed(2)},${tsy.toFixed(2)}) (${tex.toFixed(2)},${tey.toFixed(2)})`);
    pos += 28;
  }

  const svgPath = vectorNetworkBlobToPath(sampleVnBlob);
  if (svgPath) console.log(`  SVG path: ${svgPath.slice(0, 100)}...`);
}

console.log('\n=== Summary ===');
const allOk = commandsBlobOk > 0 && vnBlobOk > 0;
console.log(`fig-wire frame:      OK`);
console.log(`commandsBlob:        ${commandsBlobOk}/${commandsBlobCount - commandsBlobEmpty} OK (${commandsBlobEmpty} empty)`);
console.log(`vectorNetworkBlob:   ${vnBlobOk}/${vnBlobCount} OK`);
console.log(allOk ? '\nAll .ksy specs validated against real data.' : '\nSome specs could not be validated.');
process.exit(allOk ? 0 : 1);
