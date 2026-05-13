#!/usr/bin/env node
/**
 * Extract an icon's SVG path(s) from a node's symbol overrides.
 *
 * Figma stores instance icons as fillGeometry references inside
 * `derivedSymbolData[].fillGeometry[].commandsBlob` (the index into
 * `decoded.blobs`). The path is encoded as a sequence of single-byte
 * commands + float32 args (handled by commandsBlobToPath).
 *
 * Usage:
 *   FIGMA_KIWI_DIR=/tmp/figma_ws_frames node extract-icon.mjs <node-id>
 *
 *   --svg          wrap each path in a <svg viewBox="…"> element
 *   --match=N      print only paths longer than N chars (skip tiny placeholder shapes)
 *
 * Output is a JSON array of {path, viewBox, transform, fill, blobIdx, blobLen}
 * sorted in z-order (last drawn = top-most).
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { commandsBlobToPath, colorToHex } from '../lib/svg.mjs';
import { join } from 'path';

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';

function findFrame2(dir) {
    for (const f of readdirSync(dir)) {
        if (f.startsWith('frame_2_') && f.endsWith('.bin')) return join(dir, f);
    }
    return null;
}

async function loadScenegraph() {
    const fzstdPath = '/tmp/node_modules/fzstd/esm/index.mjs';
    if (!existsSync(fzstdPath)) {
        console.error(`fzstd not found at ${fzstdPath} — install it first`);
        process.exit(1);
    }
    const fzstd = await import(fzstdPath);
    const helpers = await import('/vagrant/.claude/skills/figma/kiwi_helpers.mjs');
    const Schema = helpers.ensureDecoder();
    const frame2Path = findFrame2(DIR);
    if (!frame2Path) {
        console.error(`No frame_2_*.bin found in ${DIR} — run figma-kiwi capture/decode first`);
        process.exit(1);
    }
    const buf = readFileSync(frame2Path);
    const data = new Uint8Array(fzstd.decompress(new Uint8Array(buf)));
    return Schema.decodeMessage(data);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { svg: false, match: 0 };
    const positional = [];
    for (const a of args) {
        if (a === '--svg') opts.svg = true;
        else if (a.startsWith('--match=')) opts.match = parseInt(a.split('=')[1], 10);
        else positional.push(a);
    }
    if (positional.length < 1) {
        console.error('Usage: extract-icon.mjs <session:localID> [--svg] [--match=N]');
        process.exit(1);
    }
    return { ...opts, nodeId: positional[0] };
}

function fillToColor(fps) {
    if (!Array.isArray(fps) || !fps.length) return null;
    for (const f of fps) {
        if (f.type === 'SOLID' && f.visible !== false) {
            return colorToHex(f.color, f.opacity);
        }
    }
    return null;
}

async function main() {
    const opts = parseArgs();
    const [s, l] = opts.nodeId.split(':').map(Number);
    if (Number.isNaN(s) || Number.isNaN(l)) {
        console.error('node-id must be sessionID:localID, e.g. 151:2428');
        process.exit(1);
    }
    const decoded = await loadScenegraph();
    const blobs = decoded.blobs || [];
    const nc = decoded.nodeChanges?.find(n => n.guid?.sessionID === s && n.guid?.localID === l);
    if (!nc) {
        console.error(`Node ${opts.nodeId} not found in scenegraph`);
        process.exit(1);
    }

    const results = [];
    const seen = new Set();

    // 1) Direct fillGeometry on a VECTOR / BOOLEAN_OPERATION / etc.
    const collect = (geo, fillOverride) => {
        for (const fg of geo || []) {
            const idx = fg.commandsBlob;
            if (idx == null || seen.has(idx)) continue;
            seen.add(idx);
            const blob = blobs[idx];
            if (!blob?.bytes) continue;
            const path = commandsBlobToPath(blob.bytes);
            if (!path) continue;
            if (path.length < opts.match) continue;
            results.push({
                blobIdx: idx,
                blobLen: blob.bytes.length,
                path,
                fill: fillOverride || fillToColor(nc.fillPaints),
                fillRule: fg.windingRule === 'NONZERO' ? 'nonzero' : 'evenodd',
            });
        }
    };
    collect(nc.fillGeometry, null);

    // 2) Symbol override geometry (the icon swap case — what we needed for the
    //    Contest Submit button at 151:2428 → blob #377 → icon-certified path).
    for (const dsd of nc.derivedSymbolData || []) {
        // Find a sibling override that pinned the fill color for the same guidPath
        let fillOverride = null;
        const lastGuid = dsd.guidPath?.guids?.slice(-1)[0];
        for (const ov of nc.symbolData?.symbolOverrides || []) {
            const ovLast = ov.guidPath?.guids?.slice(-1)[0];
            if (ovLast && lastGuid && ovLast.sessionID === lastGuid.sessionID && ovLast.localID === lastGuid.localID) {
                fillOverride = fillToColor(ov.fillPaints);
                break;
            }
        }
        collect(dsd.fillGeometry, fillOverride);
    }

    if (!results.length) {
        console.error(`No fillGeometry / commandsBlob references found on ${opts.nodeId}`);
        process.exit(2);
    }

    if (opts.svg) {
        const size = nc.size || { x: 24, y: 24 };
        const w = Math.max(1, Math.round(size.x));
        const h = Math.max(1, Math.round(size.y));
        console.log(`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`);
        for (const r of results) {
            const fill = r.fill || 'currentColor';
            console.log(`  <path d="${r.path}" fill="${fill}" fill-rule="${r.fillRule}"/>`);
        }
        console.log('</svg>');
    } else {
        console.log(JSON.stringify(results, null, 2));
    }
}

await main();
