// Orthographic PNG previews of a scene module or .schem file, for visual
// iteration without Minecraft.
//
// Usage:
//   node render-preview.mjs <scene.mjs | file.schem> [outPrefix] [options]
//
// Options:
//   --views a,b,c   views to render: front, back, left, right, top (default: all)
//   --scale N       pixels per block (default: auto-fit toward ~512px, 1-6)
//   --cut y=N       cutaway: hide all blocks with y > N (also x=N or z=N)
//   --help
//
// Orientation:
//   front  from the south (+Z) looking north; east (+X) is right
//   back   from the north (-Z) looking south; west (-X) is right
//   right  from the east (+X) looking west; north (-Z) is right
//   left   from the west (-X) looking east; south (+Z) is right
//   top    from above looking down; east (+X) is right, south (+Z) is down

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadInput } from "./schem-builder.mjs";

const COLORS = {
  // concrete
  black_concrete: [8, 10, 15],
  white_concrete: [207, 213, 214],
  gray_concrete: [54, 57, 61],
  light_gray_concrete: [125, 125, 115],
  red_concrete: [142, 32, 32],
  orange_concrete: [224, 97, 0],
  yellow_concrete: [240, 175, 21],
  lime_concrete: [94, 168, 24],
  green_concrete: [73, 91, 36],
  cyan_concrete: [21, 119, 136],
  light_blue_concrete: [35, 137, 198],
  blue_concrete: [44, 46, 143],
  purple_concrete: [100, 31, 156],
  magenta_concrete: [169, 48, 159],
  pink_concrete: [213, 101, 142],
  brown_concrete: [96, 59, 31],
  // ground
  grass_block: [111, 153, 64],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  gravel: [127, 124, 123],
  sand: [226, 215, 163],
  sandstone: [219, 207, 163],
  smooth_sandstone: [216, 203, 156],
  snow_block: [249, 254, 254],
  snow: [249, 254, 254],
  packed_ice: [141, 180, 222],
  blue_ice: [116, 167, 222],
  water: [56, 105, 200],
  // stone
  stone: [125, 125, 125],
  andesite: [136, 136, 137],
  cobblestone: [110, 110, 110],
  mossy_cobblestone: [101, 117, 93],
  stone_bricks: [122, 121, 122],
  mossy_stone_bricks: [115, 121, 105],
  bricks: [151, 97, 83],
  polished_blackstone: [53, 48, 56],
  deepslate_tiles: [54, 54, 54],
  terracotta: [152, 94, 67],
  pink_terracotta: [161, 78, 78],
  yellow_terracotta: [186, 133, 35],
  // wood
  oak_log: [102, 81, 50],
  dark_oak_log: [63, 48, 28],
  spruce_log: [58, 42, 25],
  stripped_spruce_log: [128, 98, 56],
  oak_planks: [162, 130, 78],
  spruce_planks: [114, 84, 48],
  dark_oak_planks: [66, 43, 20],
  oak_fence: [162, 130, 78],
  oak_stairs: [162, 130, 78],
  oak_slab: [162, 130, 78],
  spruce_stairs: [114, 84, 48],
  spruce_slab: [114, 84, 48],
  dark_oak_stairs: [66, 43, 20],
  stone_brick_stairs: [122, 121, 122],
  stone_brick_slab: [122, 121, 122],
  cobblestone_stairs: [110, 110, 110],
  // leaves
  oak_leaves: [86, 124, 45],
  jungle_leaves: [72, 128, 38],
  dark_oak_leaves: [64, 96, 34],
  spruce_leaves: [61, 90, 61],
  azalea_leaves: [101, 124, 47],
  flowering_azalea_leaves: [151, 119, 116],
  // metal / light / glass
  iron_block: [220, 220, 220],
  gold_block: [246, 208, 61],
  raw_gold_block: [221, 169, 46],
  cut_copper: [191, 106, 80],
  chain: [55, 60, 72],
  lantern: [235, 175, 95],
  glowstone: [252, 217, 137],
  sea_lantern: [172, 199, 190],
  glass: [201, 231, 240],
  light_blue_stained_glass: [102, 153, 216],
  honeycomb_block: [229, 148, 29],
  // wool
  black_wool: [20, 21, 25],
  gray_wool: [62, 68, 71],
};

const unknown = new Set();

// Deterministic mid-brightness color for blocks not in COLORS, so unknown
// blocks stay distinguishable from each other instead of all-magenta.
function fallbackColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return [80 + (h & 127), 80 + ((h >>> 7) & 127), 80 + ((h >>> 14) & 127)];
}

function alphaOf(name) {
  if (name === "glass" || name.endsWith("glass_pane")) return 0.35;
  if (name.endsWith("_stained_glass")) return 0.55;
  if (name === "water") return 0.6;
  return 1;
}

const styleCache = new Map();
function styleOf(fullName) {
  let style = styleCache.get(fullName);
  if (!style) {
    let n = fullName.replace("minecraft:", "");
    const bracket = n.indexOf("[");
    if (bracket >= 0) n = n.slice(0, bracket);
    let color = COLORS[n];
    if (!color) {
      unknown.add(n);
      color = fallbackColor(n);
    }
    style = { color, alpha: alphaOf(n) };
    styleCache.set(fullName, style);
  }
  return style;
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function writePng(file, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(h * (1 + w * 3)); // leading filter byte per scanline stays 0
  for (let y = 0; y < h; y++) {
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, png);
}

function usage() {
  console.log(`Usage: node render-preview.mjs <scene.mjs | file.schem> [outPrefix] [options]

Options:
  --views a,b,c   views to render: front, back, left, right, top (default: all)
  --scale N       pixels per block (default: auto-fit toward ~512px, 1-6)
  --cut y=N       cutaway: hide all blocks with y > N (also x=N or z=N)
  --help          show this help
`);
}

const positional = [];
let viewNames = null;
let scaleArg = null;
let cut = null;

const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  const value = () => {
    const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rawArgs[++i];
    if (v == null) throw new Error(`Missing value for ${arg}`);
    return v;
  };
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else if (arg === "--views" || arg.startsWith("--views=")) {
    viewNames = value().split(",").map((v) => v.trim()).filter(Boolean);
  } else if (arg === "--scale" || arg.startsWith("--scale=")) {
    scaleArg = Number(value());
    if (!Number.isInteger(scaleArg) || scaleArg < 1) throw new Error(`--scale must be a positive integer`);
  } else if (arg === "--cut" || arg.startsWith("--cut=")) {
    const spec = value();
    const m = /^([xyz])\s*=\s*(-?\d+)$/.exec(spec);
    if (!m) throw new Error(`--cut expects x=N, y=N, or z=N (got "${spec}")`);
    cut = { axis: m[1], max: Number(m[2]) };
  } else if (arg.startsWith("--")) {
    throw new Error(`Unknown option ${arg} (try --help)`);
  } else {
    positional.push(arg);
  }
}

const [scenePath, outPrefix = "preview"] = positional;
if (!scenePath) {
  usage();
  process.exit(1);
}

const s = await loadInput(scenePath);
if (s.droppedWrites) console.log(`warning: ${s.droppedWrites} writes fell outside the schematic bounds`);

const { width: W, height: H, length: L } = s;
const AIR = "minecraft:air";

// screen (sx, sy) + depth d -> world [x, y, z]
const VIEWS = {
  front: { sw: W, sh: H, depth: L, map: (sx, sy, d) => [sx, H - 1 - sy, L - 1 - d], legend: "from south (+Z) looking north; east (+X) is right" },
  back: { sw: W, sh: H, depth: L, map: (sx, sy, d) => [W - 1 - sx, H - 1 - sy, d], legend: "from north (-Z) looking south; west (-X) is right" },
  right: { sw: L, sh: H, depth: W, map: (sx, sy, d) => [W - 1 - d, H - 1 - sy, L - 1 - sx], legend: "from east (+X) looking west; north (-Z) is right" },
  left: { sw: L, sh: H, depth: W, map: (sx, sy, d) => [d, H - 1 - sy, sx], legend: "from west (-X) looking east; south (+Z) is right" },
  top: { sw: W, sh: L, depth: H, map: (sx, sy, d) => [sx, H - 1 - d, sy], legend: "from above looking down; east (+X) is right, south (+Z) is down" },
};

const selected = viewNames ?? Object.keys(VIEWS);
for (const name of selected) {
  if (!VIEWS[name]) throw new Error(`Unknown view "${name}" (valid: ${Object.keys(VIEWS).join(", ")})`);
}

let SCALE = scaleArg;
if (SCALE == null) {
  const maxDim = Math.max(...selected.map((n) => Math.max(VIEWS[n].sw, VIEWS[n].sh)));
  SCALE = Math.max(1, Math.min(6, Math.floor(512 / maxDim)));
}

const hidden = cut
  ? (x, y, z) => (cut.axis === "x" ? x : cut.axis === "y" ? y : z) > cut.max
  : () => false;
const visibleAt = (x, y, z) => {
  const b = s.blocks[s.index(x, y, z)];
  return b === AIR || hidden(x, y, z) ? null : b;
};

const BG = [24, 26, 34];

for (const viewName of selected) {
  const v = VIEWS[viewName];
  const img = Buffer.alloc(v.sw * v.sh * 3);
  for (let sy = 0; sy < v.sh; sy++) {
    for (let sx = 0; sx < v.sw; sx++) {
      let r = 0, g = 0, b = 0, transmit = 1;
      for (let d = 0; d < v.depth; d++) {
        const [x, y, z] = v.map(sx, sy, d);
        const name = visibleAt(x, y, z);
        if (!name) continue;
        const style = styleOf(name);
        let f = Math.max(0.55, 1.02 - 0.012 * d); // depth shade, floored so far blocks stay visible
        if (y + 1 >= H || !visibleAt(x, y + 1, z)) f *= 1.16; // lit from above
        const w = transmit * style.alpha;
        r += w * style.color[0] * f;
        g += w * style.color[1] * f;
        b += w * style.color[2] * f;
        transmit *= 1 - style.alpha;
        if (transmit < 0.02) break;
      }
      r += transmit * BG[0];
      g += transmit * BG[1];
      b += transmit * BG[2];
      const o = (sy * v.sw + sx) * 3;
      img[o] = Math.max(0, Math.min(255, Math.round(r)));
      img[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      img[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  const outFile = `${outPrefix}-${viewName}.png`;
  if (SCALE === 1) {
    writePng(outFile, v.sw, v.sh, img);
  } else {
    // nearest-neighbor upscale
    const big = Buffer.alloc(v.sw * SCALE * v.sh * SCALE * 3);
    for (let y = 0; y < v.sh * SCALE; y++) {
      for (let x = 0; x < v.sw * SCALE; x++) {
        const src = (Math.floor(y / SCALE) * v.sw + Math.floor(x / SCALE)) * 3;
        const dst = (y * v.sw * SCALE + x) * 3;
        img.copy(big, dst, src, src + 3);
      }
    }
    writePng(outFile, v.sw * SCALE, v.sh * SCALE, big);
  }
  console.log(`wrote ${outFile}  (${viewName}: ${v.legend})`);
}

console.log(`scene ${W}x${H}x${L}, scale ${SCALE}${cut ? `, cut: ${cut.axis} > ${cut.max} hidden` : ""}`);
if (unknown.size) console.log("no color entry for:", [...unknown].join(", "), "(deterministic fallback colors used)");
