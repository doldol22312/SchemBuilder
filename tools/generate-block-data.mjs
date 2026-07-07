// Generates block-data.json: the full Minecraft block registry (names, block
// state properties, and per-block average texture colors) used by
// schem-builder for validation and by render-preview for truthful colors.
//
// Usage: node tools/generate-block-data.mjs [--version 26.2] [--workdir out/gen]
//
// Sources (downloaded on demand, cached in the workdir):
//   - Mojang version manifest + client jar: block textures, blockstates, models
//   - misode/mcmeta "<version>-summary" tag: block registry + state schema
//     (a per-version mirror of Mojang's official data-generator output)
//
// The client jar is unpacked with the system `tar` (bsdtar reads zip archives;
// on Windows that is C:\Windows\System32\tar.exe).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const WORKDIR = path.resolve(argOf("--workdir", "out/gen"));
fs.mkdirSync(WORKDIR, { recursive: true });

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// 1. Resolve version and fetch sources

const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
const VERSION = argOf("--version", manifest.latest.release);
const entry = manifest.versions.find((v) => v.id === VERSION);
if (!entry) throw new Error(`Version ${VERSION} not in Mojang's manifest`);
console.log(`Minecraft ${VERSION}`);

const versionJsonFile = path.join(WORKDIR, `mc-${VERSION}.json`);
await download(entry.url, versionJsonFile);
const versionJson = JSON.parse(fs.readFileSync(versionJsonFile, "utf8"));

const jarFile = path.join(WORKDIR, `client-${VERSION}.jar`);
await download(versionJson.downloads.client.url, jarFile);

// Registry + state schema from mcmeta's per-version summary tag.
// raw.githubusercontent.com is blocked on some networks; the GitHub contents
// API serves the same bytes with the raw media type.
const registryFile = path.join(WORKDIR, `registry-${VERSION}.json`);
if (!fs.existsSync(registryFile)) {
  const url = `https://api.github.com/repos/misode/mcmeta/contents/blocks/data.min.json?ref=${VERSION}-summary`;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { headers: { Accept: "application/vnd.github.raw" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url} (no mcmeta summary for ${VERSION}?)`);
  fs.writeFileSync(registryFile, Buffer.from(await res.arrayBuffer()));
}
const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
console.log(`registry: ${Object.keys(registry).length} blocks`);

// Unpack the assets we need from the jar.
const assetsDir = path.join(WORKDIR, `assets-${VERSION}`);
if (!fs.existsSync(path.join(assetsDir, "assets/minecraft/blockstates"))) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, [
    "-xf", jarFile, "-C", assetsDir,
    "assets/minecraft/textures/block",
    "assets/minecraft/blockstates",
    "assets/minecraft/models/block",
  ]);
}
const mcDir = path.join(assetsDir, "assets", "minecraft");

// ---------------------------------------------------------------------------
// 2. Minimal PNG decoder (enough for Minecraft textures)

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("missing IHDR");
  if (ihdr.interlace) throw new Error("interlaced PNG not supported");
  const { width, height, depth, colorType } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels == null) throw new Error(`color type ${colorType} not supported`);
  if (colorType !== 3 && colorType !== 0 && depth !== 8) throw new Error(`bit depth ${depth} not supported for color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const lines = Buffer.alloc(height * bytesPerRow);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (bytesPerRow + 1)];
    const src = raw.subarray(y * (bytesPerRow + 1) + 1, (y + 1) * (bytesPerRow + 1));
    const out = lines.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    const prev = y > 0 ? lines.subarray((y - 1) * bytesPerRow, y * bytesPerRow) : null;
    for (let i = 0; i < bytesPerRow; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 255;
    }
  }

  // Expand to RGBA
  const rgba = Buffer.alloc(width * height * 4);
  const readIndexed = (x, y) => {
    const bitPos = y * bytesPerRow * 8 + x * depth;
    const byte = lines[bitPos >> 3];
    const shift = 8 - depth - (bitPos & 7);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = readIndexed(x, y);
        rgba[o] = palette[idx * 3];
        rgba[o + 1] = palette[idx * 3 + 1];
        rgba[o + 2] = palette[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const i = y * bytesPerRow + x * channels;
        if (colorType === 0) {
          const v = depth === 8 ? lines[i] : Math.round((readIndexed(x, y) * 255) / ((1 << depth) - 1));
          rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
          rgba[o + 3] = 255;
        } else if (colorType === 4) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = lines[i];
          rgba[o + 3] = lines[i + 1];
        } else if (colorType === 2) {
          rgba[o] = lines[i]; rgba[o + 1] = lines[i + 1]; rgba[o + 2] = lines[i + 2];
          rgba[o + 3] = 255;
        } else {
          rgba[o] = lines[i]; rgba[o + 1] = lines[i + 1]; rgba[o + 2] = lines[i + 2];
          rgba[o + 3] = lines[i + 3];
        }
      }
    }
  }
  return { width, height, rgba };
}

// Alpha-weighted average color of a texture. Animated textures (height a
// multiple of width) only count the first frame. Returns null for fully
// transparent textures. minAlpha reports the most transparent pixel seen.
const textureCache = new Map();
function textureColor(ref) {
  let t = textureCache.get(ref);
  if (t !== undefined) return t;
  const rel = ref.replace("minecraft:", "");
  const file = path.join(mcDir, "textures", `${rel}.png`);
  if (!fs.existsSync(file)) {
    textureCache.set(ref, null);
    return null;
  }
  let png;
  try {
    png = decodePng(fs.readFileSync(file));
  } catch (err) {
    console.warn(`  ! ${rel}.png: ${err.message}`);
    textureCache.set(ref, null);
    return null;
  }
  const frameH = png.height >= png.width && png.height % png.width === 0 ? png.width : png.height;
  let r = 0, g = 0, b = 0, w = 0, minAlpha = 255;
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const a = png.rgba[o + 3];
      if (a < minAlpha) minAlpha = a;
      if (a === 0) continue;
      const k = a / 255;
      r += png.rgba[o] * k; g += png.rgba[o + 1] * k; b += png.rgba[o + 2] * k;
      w += k;
    }
  }
  t = w === 0 ? null : { color: [r / w, g / w, b / w], minAlpha };
  textureCache.set(ref, t);
  return t;
}

// ---------------------------------------------------------------------------
// 3. blockstate -> models -> textures -> average color

const modelCache = new Map();
function loadModel(ref) {
  const rel = ref.replace("minecraft:", "");
  let m = modelCache.get(rel);
  if (m === undefined) {
    const file = path.join(mcDir, "models", `${rel}.json`);
    m = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    modelCache.set(rel, m);
  }
  return m;
}

// Walk the parent chain, merging texture maps (child wins) and resolving
// #references. Returns { textures: [refs], root: deepest parent name }.
function resolveModel(ref) {
  const chain = [];
  let root = ref.replace("minecraft:", "");
  for (let cur = ref; cur; ) {
    const m = loadModel(cur);
    if (!m) break;
    chain.push(m);
    root = cur.replace("minecraft:", "");
    cur = m.parent;
  }
  const map = {};
  for (let i = chain.length - 1; i >= 0; i--) Object.assign(map, chain[i].textures ?? {});
  // Texture values are plain refs, or (26.x+) objects like
  // { sprite: "minecraft:block/glass", force_translucent: true }.
  let forceTranslucent = false;
  const resolve = (v, depth = 0) => {
    if (v && typeof v === "object") {
      if (v.force_translucent) forceTranslucent = true;
      v = v.sprite;
    }
    if (typeof v !== "string") return null;
    return v.startsWith("#") && depth < 8 ? resolve(map[v.slice(1)], depth + 1) : v;
  };
  const textures = [];
  for (const [key, value] of Object.entries(map)) {
    if (key === "particle") continue;
    const v = resolve(value);
    if (v && !textures.includes(v)) textures.push(v);
  }
  if (!textures.length && map.particle) {
    const v = resolve(map.particle);
    if (v) textures.push(v);
  }
  // Full-cube signal: a cube-family parent, or an element spanning the whole
  // 16x16x16 box (grass_block-style inline models).
  const fullElement = chain.some((m) =>
    (m.elements ?? []).some(
      (e) => String(e.from) === "0,0,0" && String(e.to) === "16,16,16",
    ),
  );
  return { textures, root, isCube: root.includes("cube") || root === "block/leaves" || fullElement, forceTranslucent };
}

function modelsOf(blockName) {
  const file = path.join(mcDir, "blockstates", `${blockName}.json`);
  if (!fs.existsSync(file)) return [];
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const models = [];
  const push = (v) => {
    for (const e of Array.isArray(v) ? v : [v]) {
      if (e?.model && !models.includes(e.model)) models.push(e.model);
    }
  };
  if (state.variants) for (const v of Object.values(state.variants)) push(v);
  if (state.multipart) for (const part of state.multipart) push(part.apply);
  return models.slice(0, 8);
}

// Biome-tinted textures ship grayscale; multiply by the standard plains-biome
// tint so previews match what players actually see.
const GRASS_TINT = [145, 189, 89]; // #91BD59
const FOLIAGE_TINT = [119, 171, 47]; // #77AB2F
const WATER_TINT = [63, 118, 228]; // #3F76E4
const TINTS = {
  grass_block: GRASS_TINT,
  short_grass: GRASS_TINT,
  grass: GRASS_TINT,
  tall_grass: GRASS_TINT,
  fern: GRASS_TINT,
  large_fern: GRASS_TINT,
  potted_fern: GRASS_TINT,
  sugar_cane: GRASS_TINT,
  bush: GRASS_TINT,
  oak_leaves: FOLIAGE_TINT,
  jungle_leaves: FOLIAGE_TINT,
  acacia_leaves: FOLIAGE_TINT,
  dark_oak_leaves: FOLIAGE_TINT,
  mangrove_leaves: FOLIAGE_TINT,
  vine: FOLIAGE_TINT,
  lily_pad: FOLIAGE_TINT,
  spruce_leaves: [97, 153, 97], // fixed leaf tints
  birch_leaves: [128, 167, 85],
  water: WATER_TINT,
  water_cauldron: WATER_TINT,
  bubble_column: WATER_TINT,
  redstone_wire: [175, 24, 5],
};

function blockColor(name) {
  const models = modelsOf(name);
  if (!models.length) return { color: null, cube: false, translucent: false };
  let r = 0, g = 0, b = 0, n = 0;
  let cube = false;
  let minAlpha = 255;
  for (let i = 0; i < models.length; i++) {
    const { textures, isCube, forceTranslucent } = resolveModel(models[i]);
    // Only the first (default-state) model decides the full-cube flag: a slab's
    // type=double variant or snow's layers=8 shouldn't mark the block a cube.
    if (i === 0 && isCube) cube = true;
    if (forceTranslucent) minAlpha = 0;
    for (const t of textures) {
      const tex = textureColor(t);
      if (!tex) continue;
      r += tex.color[0]; g += tex.color[1]; b += tex.color[2];
      if (tex.minAlpha < minAlpha) minAlpha = tex.minAlpha;
      n++;
    }
  }
  if (!n) return { color: null, cube: false, translucent: false };
  let color = [r / n, g / n, b / n];
  const tint = TINTS[name];
  if (tint) color = [color[0] * tint[0] / 255, color[1] * tint[1] / 255, color[2] * tint[2] / 255];
  return { color: color.map((v) => Math.round(v)), cube, translucent: minAlpha < 250 };
}

// ---------------------------------------------------------------------------
// 4. Assemble and write block-data.json

const blocks = {};
let colored = 0, cubes = 0;
const uncolored = [];
for (const [name, [props]] of Object.entries(registry)) {
  const { color, cube, translucent } = blockColor(name);
  const rec = {};
  if (Object.keys(props).length) rec.p = props;
  if (color) {
    rec.c = color;
    colored++;
  } else uncolored.push(name);
  if (cube && !translucent) {
    rec.q = 1; // full opaque cube: safe for pixel art / nearestBlock
    cubes++;
  }
  blocks[name] = rec;
}

const out = {
  mcVersion: VERSION,
  source: "Mojang client assets + misode/mcmeta block summary; see tools/generate-block-data.mjs",
  blocks,
};
const outFile = path.resolve("block-data.json");
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`\nwrote ${outFile}`);
console.log(`${Object.keys(blocks).length} blocks, ${colored} with colors, ${cubes} full opaque cubes`);
console.log(`no color (technical/invisible): ${uncolored.join(", ")}`);
