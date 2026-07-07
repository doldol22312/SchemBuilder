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
import { loadInput, blockColor } from "./schem-builder.mjs";

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
  // concrete powder
  black_concrete_powder: [25, 26, 31],
  white_concrete_powder: [225, 227, 227],
  gray_concrete_powder: [76, 83, 86],
  light_gray_concrete_powder: [154, 154, 148],
  red_concrete_powder: [168, 54, 50],
  orange_concrete_powder: [227, 131, 31],
  yellow_concrete_powder: [232, 199, 54],
  lime_concrete_powder: [125, 189, 42],
  green_concrete_powder: [97, 119, 44],
  cyan_concrete_powder: [36, 147, 157],
  light_blue_concrete_powder: [74, 180, 213],
  blue_concrete_powder: [70, 73, 166],
  purple_concrete_powder: [131, 55, 177],
  magenta_concrete_powder: [192, 83, 184],
  pink_concrete_powder: [228, 153, 181],
  brown_concrete_powder: [125, 84, 53],
  // wool
  black_wool: [20, 21, 25],
  white_wool: [233, 236, 236],
  gray_wool: [62, 68, 71],
  light_gray_wool: [142, 142, 134],
  red_wool: [160, 39, 34],
  orange_wool: [240, 118, 19],
  yellow_wool: [248, 197, 39],
  lime_wool: [112, 185, 25],
  green_wool: [84, 109, 27],
  cyan_wool: [21, 137, 145],
  light_blue_wool: [58, 175, 217],
  blue_wool: [53, 57, 157],
  purple_wool: [121, 42, 172],
  magenta_wool: [189, 68, 179],
  pink_wool: [237, 141, 172],
  brown_wool: [114, 71, 40],
  // terracotta
  terracotta: [152, 94, 67],
  black_terracotta: [37, 22, 16],
  white_terracotta: [209, 178, 161],
  gray_terracotta: [57, 42, 35],
  light_gray_terracotta: [135, 106, 97],
  red_terracotta: [143, 61, 46],
  orange_terracotta: [161, 83, 37],
  yellow_terracotta: [186, 133, 35],
  lime_terracotta: [103, 117, 52],
  green_terracotta: [76, 83, 42],
  cyan_terracotta: [86, 91, 91],
  light_blue_terracotta: [113, 108, 137],
  blue_terracotta: [74, 59, 91],
  purple_terracotta: [118, 70, 86],
  magenta_terracotta: [149, 88, 108],
  pink_terracotta: [161, 78, 78],
  brown_terracotta: [77, 51, 35],
  // glazed terracotta
  black_glazed_terracotta: [67, 30, 32],
  white_glazed_terracotta: [188, 212, 202],
  gray_glazed_terracotta: [83, 90, 93],
  light_gray_glazed_terracotta: [144, 166, 167],
  red_glazed_terracotta: [181, 59, 53],
  orange_glazed_terracotta: [154, 147, 91],
  yellow_glazed_terracotta: [234, 192, 88],
  lime_glazed_terracotta: [162, 197, 55],
  green_glazed_terracotta: [117, 142, 67],
  cyan_glazed_terracotta: [52, 118, 125],
  light_blue_glazed_terracotta: [94, 164, 208],
  blue_glazed_terracotta: [47, 64, 139],
  purple_glazed_terracotta: [109, 48, 152],
  magenta_glazed_terracotta: [208, 100, 191],
  pink_glazed_terracotta: [235, 154, 181],
  brown_glazed_terracotta: [119, 106, 85],
  // stained glass (translucency comes from alphaOf)
  glass: [201, 231, 240],
  tinted_glass: [44, 38, 46],
  black_stained_glass: [25, 25, 25],
  white_stained_glass: [255, 255, 255],
  gray_stained_glass: [76, 76, 76],
  light_gray_stained_glass: [153, 153, 153],
  red_stained_glass: [153, 51, 51],
  orange_stained_glass: [216, 127, 51],
  yellow_stained_glass: [229, 229, 51],
  lime_stained_glass: [127, 204, 25],
  green_stained_glass: [102, 127, 51],
  cyan_stained_glass: [76, 127, 153],
  light_blue_stained_glass: [102, 153, 216],
  blue_stained_glass: [51, 76, 178],
  purple_stained_glass: [127, 63, 178],
  magenta_stained_glass: [178, 76, 216],
  pink_stained_glass: [242, 127, 165],
  brown_stained_glass: [102, 76, 51],
  // copper oxidation stages (waxed_ variants resolve to these)
  copper_block: [192, 107, 79],
  exposed_copper: [161, 125, 103],
  weathered_copper: [108, 153, 110],
  oxidized_copper: [82, 162, 132],
  cut_copper: [191, 106, 80],
  exposed_cut_copper: [154, 121, 101],
  weathered_cut_copper: [109, 145, 107],
  oxidized_cut_copper: [79, 153, 126],
  copper_grate: [192, 107, 79],
  chiseled_copper: [186, 100, 73],
  copper_bulb: [212, 128, 88],
  // ground
  grass_block: [111, 153, 64],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  mud: [60, 57, 60],
  gravel: [127, 124, 123],
  sand: [226, 215, 163],
  red_sand: [190, 102, 33],
  sandstone: [219, 207, 163],
  smooth_sandstone: [216, 203, 156],
  red_sandstone: [186, 99, 29],
  snow_block: [249, 254, 254],
  snow: [249, 254, 254],
  packed_ice: [141, 180, 222],
  blue_ice: [116, 167, 222],
  ice: [145, 183, 253],
  water: [56, 105, 200],
  moss_block: [89, 109, 45],
  hay_block: [166, 136, 38],
  pumpkin: [196, 113, 25],
  bone_block: [229, 225, 207],
  // stone
  stone: [125, 125, 125],
  andesite: [136, 136, 137],
  diorite: [189, 188, 189],
  granite: [149, 103, 86],
  cobblestone: [110, 110, 110],
  mossy_cobblestone: [101, 117, 93],
  stone_bricks: [122, 121, 122],
  mossy_stone_bricks: [115, 121, 105],
  bricks: [151, 97, 83],
  calcite: [223, 224, 220],
  tuff: [108, 109, 102],
  basalt: [74, 74, 78],
  smooth_basalt: [72, 72, 78],
  deepslate: [80, 80, 82],
  polished_deepslate: [72, 72, 73],
  deepslate_bricks: [70, 70, 71],
  deepslate_tiles: [54, 54, 54],
  polished_blackstone: [53, 48, 56],
  blackstone: [42, 36, 41],
  obsidian: [15, 11, 25],
  crying_obsidian: [32, 10, 60],
  netherrack: [98, 38, 38],
  nether_bricks: [44, 21, 26],
  red_nether_bricks: [69, 7, 9],
  magma_block: [142, 63, 31],
  end_stone: [219, 222, 158],
  purpur_block: [170, 126, 170],
  quartz_block: [236, 230, 223],
  smooth_quartz: [236, 230, 223],
  prismarine: [99, 156, 151],
  prismarine_bricks: [99, 171, 158],
  dark_prismarine: [51, 91, 75],
  amethyst_block: [133, 97, 191],
  // wood
  oak_log: [102, 81, 50],
  dark_oak_log: [63, 48, 28],
  spruce_log: [58, 42, 25],
  stripped_spruce_log: [128, 98, 56],
  oak_planks: [162, 130, 78],
  spruce_planks: [114, 84, 48],
  dark_oak_planks: [66, 43, 20],
  birch_planks: [192, 175, 121],
  jungle_planks: [160, 115, 80],
  acacia_planks: [168, 90, 50],
  mangrove_planks: [117, 54, 48],
  cherry_planks: [226, 178, 172],
  bamboo_planks: [193, 173, 85],
  crimson_planks: [101, 48, 70],
  warped_planks: [43, 104, 99],
  // leaves
  oak_leaves: [86, 124, 45],
  jungle_leaves: [72, 128, 38],
  dark_oak_leaves: [64, 96, 34],
  spruce_leaves: [61, 90, 61],
  azalea_leaves: [101, 124, 47],
  flowering_azalea_leaves: [151, 119, 116],
  // metal / mineral / light
  iron_block: [220, 220, 220],
  gold_block: [246, 208, 61],
  raw_gold_block: [221, 169, 46],
  redstone_block: [175, 24, 5],
  emerald_block: [42, 203, 87],
  lapis_block: [30, 64, 201],
  diamond_block: [98, 219, 214],
  netherite_block: [66, 61, 63],
  coal_block: [16, 15, 15],
  slime_block: [111, 192, 91],
  chain: [55, 60, 72],
  lantern: [235, 175, 95],
  glowstone: [252, 217, 137],
  sea_lantern: [172, 199, 190],
  shroomlight: [240, 146, 70],
  honeycomb_block: [229, 148, 29],
};

// Color lookup order: hand-tuned COLORS, then the generated registry
// (block-data.json: every block's average texture color), then shaped-variant
// derivation (waxed copper, panes, carpet, stairs / slabs / walls / fences
// resolve to their base block).
function resolveColor(n) {
  if (COLORS[n]) return COLORS[n];
  const registry = blockColor(`minecraft:${n}`);
  if (registry) return registry;
  if (n.startsWith("waxed_")) return resolveColor(n.slice(6));
  if (n.endsWith("_pane")) return resolveColor(n.slice(0, -5));
  if (n.endsWith("_carpet")) return resolveColor(n.slice(0, -7) + "_wool");
  for (const suffix of ["_stairs", "_slab", "_wall", "_fence_gate", "_fence"]) {
    if (n.endsWith(suffix)) {
      const stem = n.slice(0, -suffix.length);
      return COLORS[stem] ?? COLORS[stem + "s"] ?? COLORS[stem + "_block"] ?? COLORS[stem + "_planks"];
    }
  }
  return undefined;
}

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
    let color = resolveColor(n);
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
