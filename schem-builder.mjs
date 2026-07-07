import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
};

// .schem stores Width/Height/Length as shorts.
const MAX_DIMENSION = 32767;

// ---------------------------------------------------------------------------
// Block registry: every block in the game with its state schema and average
// texture color, generated from Mojang's own assets by
// tools/generate-block-data.mjs. Optional — without the file, validation is
// skipped and the color helpers are unavailable.

let REGISTRY = null;
let REGISTRY_VERSION = null;
try {
  const parsed = JSON.parse(fs.readFileSync(new URL("./block-data.json", import.meta.url), "utf8"));
  REGISTRY = parsed.blocks;
  REGISTRY_VERSION = parsed.mcVersion;
} catch {
  // block-data.json missing: library still works, just without validation
}

export function registryInfo() {
  return REGISTRY ? { mcVersion: REGISTRY_VERSION, blocks: Object.keys(REGISTRY).length } : null;
}

function levenshtein(a, b, cap) {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function suggestBlock(plain) {
  let best = null;
  let bestD = 4; // suggestions further than 3 edits away are noise
  for (const key of Object.keys(REGISTRY)) {
    const d = levenshtein(plain, key, bestD);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return best;
}

function computeBlockError(full) {
  const bracket = full.indexOf("[");
  const base = bracket >= 0 ? full.slice(0, bracket) : full;
  if (!base.startsWith("minecraft:")) return null; // other namespaces: not validated
  const plain = base.slice("minecraft:".length);
  const rec = REGISTRY[plain];
  if (!rec) {
    const hint = suggestBlock(plain);
    return `Unknown block "${base}" (Minecraft ${REGISTRY_VERSION})${hint ? ` — did you mean "${hint}"?` : ""}`;
  }
  if (bracket >= 0) {
    if (!full.endsWith("]")) return `Malformed block states in "${full}"`;
    const props = rec.p ?? {};
    for (const pair of full.slice(bracket + 1, -1).split(",")) {
      const eq = pair.indexOf("=");
      const key = eq > 0 ? pair.slice(0, eq).trim() : pair.trim();
      const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
      if (!(key in props)) {
        const keys = Object.keys(props);
        return `Block "${plain}" has no state "${key}"${keys.length ? ` (valid: ${keys.join(", ")})` : " (it has no states)"}`;
      }
      if (!props[key].includes(value)) {
        return `Invalid value "${value}" for "${plain}[${key}=...]" (valid: ${props[key].join(", ")})`;
      }
    }
  }
  return null;
}

const validationCache = new Map();

// Returns null when the block string is valid (or can't be checked: other
// namespace, or no registry file), else a human-readable error message.
export function blockError(name) {
  if (!REGISTRY) return null;
  let msg = validationCache.get(name);
  if (msg === undefined) {
    msg = computeBlockError(name);
    validationCache.set(name, msg);
  }
  return msg;
}

// Average texture color of a block as [r, g, b], or null when unknown.
// States are ignored: blockColor("oak_stairs[facing=east]") works.
export function blockColor(name) {
  if (!REGISTRY) return null;
  let full = block(name);
  const bracket = full.indexOf("[");
  if (bracket >= 0) full = full.slice(0, bracket);
  if (!full.startsWith("minecraft:")) return null;
  const rec = REGISTRY[full.slice("minecraft:".length)];
  return rec?.c ? [...rec.c] : null;
}

function parseColor(c) {
  if (Array.isArray(c) && c.length === 3) return c;
  if (typeof c === "string") {
    const hex = c.startsWith("#") ? c.slice(1) : c;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    const fromBlock = blockColor(c);
    if (fromBlock) return fromBlock;
  }
  throw new Error(`Cannot interpret color ${JSON.stringify(c)} (use [r,g,b], "#rrggbb", or a block name)`);
}

function colorDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db; // eye-weighted: green counts most
}

// The block whose average texture color is closest to `color` ([r,g,b],
// "#rrggbb", or another block name). By default only full opaque cubes are
// considered — the safe palette for pixel art and organic shading. Options:
// { all: true } to include every block, { exclude: [names] }, { count: N }
// to get the N closest as an array.
export function nearestBlock(color, options = {}) {
  if (!REGISTRY) throw new Error("nearestBlock requires block-data.json (run: node tools/generate-block-data.mjs)");
  const target = parseColor(color);
  const exclude = new Set((options.exclude ?? []).map((n) => block(n).replace("minecraft:", "")));
  const ranked = [];
  for (const [name, rec] of Object.entries(REGISTRY)) {
    if (!rec.c || exclude.has(name)) continue;
    if (!options.all && !rec.q) continue;
    ranked.push([colorDistance(target, rec.c), name]);
  }
  if (!ranked.length) throw new Error("No candidate blocks left after filtering");
  ranked.sort((a, b) => a[0] - b[0]);
  if (options.count == null) return `minecraft:${ranked[0][1]}`;
  return ranked.slice(0, options.count).map(([, name]) => `minecraft:${name}`);
}

// A block palette fading from one color to another in `steps` steps. Ends
// accept anything parseColor takes, including block names:
// gradient("red_concrete", "#000000", 6). Takes nearestBlock's options.
export function gradient(from, to, steps, options = {}) {
  if (!Number.isInteger(steps) || steps < 2) throw new Error("gradient needs an integer steps >= 2");
  const a = parseColor(from);
  const b = parseColor(to);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    out.push(nearestBlock([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], options));
  }
  return out;
}

export function block(name) {
  if (name === "air" || name === "minecraft:air") return "minecraft:air";
  if (typeof name !== "string" || !name.length) {
    throw new Error(`Invalid block name: ${String(name)}`);
  }
  return name.includes(":") ? name : `minecraft:${name}`;
}

// Compose or merge block states: withState("lantern", { hanging: true })
// -> "minecraft:lantern[hanging=true]". Existing states in the name are kept
// unless overridden.
export function withState(name, states = {}) {
  const full = block(name);
  const bracket = full.indexOf("[");
  const base = bracket >= 0 ? full.slice(0, bracket) : full;
  const merged = {};
  if (bracket >= 0) {
    for (const pair of full.slice(bracket + 1, full.length - 1).split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) merged[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  for (const [key, value] of Object.entries(states)) merged[key] = String(value);
  const entries = Object.entries(merged);
  if (!entries.length) return base;
  return `${base}[${entries.map(([k, v]) => `${k}=${v}`).join(",")}]`;
}

// stairs("stone_brick", "north") -> fully qualified stairs block string.
// facing is the ascending direction; half is "bottom" or "top".
export function stairs(material, facing = "north", half = "bottom", shape = "straight") {
  const full = block(material);
  const bracket = full.indexOf("[");
  const base = bracket >= 0 ? full.slice(0, bracket) : full;
  const name = base.endsWith("_stairs") ? full : `${base}_stairs`;
  return withState(name, { facing, half, shape, waterlogged: false });
}

export const blocks = Object.freeze({
  air: "minecraft:air",
  black: "minecraft:black_concrete",
  white: "minecraft:white_concrete",
  gray: "minecraft:gray_concrete",
  lightGray: "minecraft:light_gray_concrete",
  red: "minecraft:red_concrete",
  orange: "minecraft:orange_concrete",
  yellow: "minecraft:yellow_concrete",
  lime: "minecraft:lime_concrete",
  green: "minecraft:green_concrete",
  cyan: "minecraft:cyan_concrete",
  lightBlue: "minecraft:light_blue_concrete",
  blue: "minecraft:blue_concrete",
  purple: "minecraft:purple_concrete",
  magenta: "minecraft:magenta_concrete",
  pink: "minecraft:pink_concrete",
  brown: "minecraft:brown_concrete",
  grass: "minecraft:grass_block",
  dirt: "minecraft:dirt",
  coarseDirt: "minecraft:coarse_dirt",
  stone: "minecraft:stone",
  andesite: "minecraft:andesite",
  cobblestone: "minecraft:cobblestone",
  mossyCobblestone: "minecraft:mossy_cobblestone",
  gravel: "minecraft:gravel",
  sand: "minecraft:sand",
  sandstone: "minecraft:sandstone",
  snow: "minecraft:snow_block",
  packedIce: "minecraft:packed_ice",
  blueIce: "minecraft:blue_ice",
  oakLog: "minecraft:oak_log",
  darkOakLog: "minecraft:dark_oak_log",
  spruceLog: "minecraft:spruce_log",
  oakPlanks: "minecraft:oak_planks",
  sprucePlanks: "minecraft:spruce_planks",
  darkOakPlanks: "minecraft:dark_oak_planks",
  oakFence: "minecraft:oak_fence",
  chain: "minecraft:chain",
  lantern: "minecraft:lantern[hanging=false,waterlogged=false]",
  iron: "minecraft:iron_block",
  gold: "minecraft:gold_block",
  copper: "minecraft:cut_copper",
  glowstone: "minecraft:glowstone",
  seaLantern: "minecraft:sea_lantern",
  glass: "minecraft:glass",
  lightBlueGlass: "minecraft:light_blue_stained_glass",
  blackstone: "minecraft:polished_blackstone",
  deepslateTiles: "minecraft:deepslate_tiles",
  stoneBricks: "minecraft:stone_bricks",
  mossyStoneBricks: "minecraft:mossy_stone_bricks",
  bricks: "minecraft:bricks",
  water: "minecraft:water[level=0]",
  oakLeaves: "minecraft:oak_leaves[persistent=true,distance=1]",
  jungleLeaves: "minecraft:jungle_leaves[persistent=true,distance=1]",
  darkOakLeaves: "minecraft:dark_oak_leaves[persistent=true,distance=1]",
  spruceLeaves: "minecraft:spruce_leaves[persistent=true,distance=1]",
  azaleaLeaves: "minecraft:azalea_leaves[persistent=true,distance=1]",
  floweringAzaleaLeaves: "minecraft:flowering_azalea_leaves[persistent=true,distance=1]",
});

// Deterministic noise in [0, 1). Same inputs (and seed) always give the same
// value; pass a different seed for a different but equally stable pattern.
export function hash3(x, y, z = 0, seed = 0) {
  let n = (
    Math.imul(Math.floor(x), 374761393) +
    Math.imul(Math.floor(y), 668265263) +
    Math.imul(Math.floor(z), 2246822519) +
    Math.imul(Math.floor(seed), 3266489917)
  ) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function pick(items, x, y, z = 0, seed = 0) {
  if (!items.length) throw new Error("Cannot pick from an empty array");
  return items[Math.min(items.length - 1, Math.floor(hash3(x, y, z, seed) * items.length))];
}

export function paletteOf(materialOrPalette) {
  return Array.isArray(materialOrPalette) ? materialOrPalette.map(block) : [block(materialOrPalette)];
}

export function materialAt(materialOrPalette, x, y, z = 0, seed = 0) {
  const palette = paletteOf(materialOrPalette);
  return palette.length === 1 ? palette[0] : pick(palette, x, y, z, seed);
}

class NbtWriter {
  constructor() {
    this.parts = [];
  }

  push(buffer) {
    this.parts.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  }

  ubyte(value) {
    this.parts.push(Buffer.from([value & 255]));
  }

  short(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(value);
    this.parts.push(buffer);
  }

  int(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    this.parts.push(buffer);
  }

  stringPayload(value) {
    const buffer = Buffer.from(value, "utf8");
    this.short(buffer.length);
    this.push(buffer);
  }

  namedTag(type, name, writePayload) {
    this.ubyte(type);
    this.stringPayload(name);
    writePayload();
  }

  end() {
    this.ubyte(TAG.End);
  }

  buffer() {
    return Buffer.concat(this.parts);
  }
}

function encodeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let temp = current & 0x7f;
    current >>>= 7;
    if (current !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (current !== 0);
  return bytes;
}

// Parses uncompressed NBT into { name, value }. Compounds become plain
// objects, lists become arrays, ByteArray stays a Buffer.
export function parseNbt(buffer) {
  let o = 0;
  function payload(type) {
    switch (type) {
      case TAG.Byte: { const v = buffer.readInt8(o); o += 1; return v; }
      case TAG.Short: { const v = buffer.readInt16BE(o); o += 2; return v; }
      case TAG.Int: { const v = buffer.readInt32BE(o); o += 4; return v; }
      case TAG.Long: { const v = buffer.readBigInt64BE(o); o += 8; return v; }
      case TAG.Float: { const v = buffer.readFloatBE(o); o += 4; return v; }
      case TAG.Double: { const v = buffer.readDoubleBE(o); o += 8; return v; }
      case TAG.ByteArray: {
        const n = buffer.readInt32BE(o); o += 4;
        const v = buffer.subarray(o, o + n); o += n;
        return v;
      }
      case TAG.String: {
        const n = buffer.readUInt16BE(o); o += 2;
        const v = buffer.toString("utf8", o, o + n); o += n;
        return v;
      }
      case TAG.List: {
        const itemType = buffer.readUInt8(o); o += 1;
        const n = buffer.readInt32BE(o); o += 4;
        const items = [];
        for (let i = 0; i < n; i++) items.push(payload(itemType));
        return items;
      }
      case TAG.Compound: {
        const compound = {};
        for (;;) {
          const itemType = buffer.readUInt8(o); o += 1;
          if (itemType === TAG.End) return compound;
          const nameLen = buffer.readUInt16BE(o); o += 2;
          const name = buffer.toString("utf8", o, o + nameLen); o += nameLen;
          compound[name] = payload(itemType);
        }
      }
      case TAG.IntArray: {
        const n = buffer.readInt32BE(o); o += 4;
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) { v[i] = buffer.readInt32BE(o); o += 4; }
        return v;
      }
      case TAG.LongArray: {
        const n = buffer.readInt32BE(o); o += 4;
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) { v[i] = buffer.readBigInt64BE(o); o += 8; }
        return v;
      }
      default:
        throw new Error(`Unknown NBT tag type ${type} at byte ${o - 1}`);
    }
  }

  const rootType = buffer.readUInt8(o); o += 1;
  if (rootType !== TAG.Compound) throw new Error("Not an NBT compound root");
  const nameLen = buffer.readUInt16BE(o); o += 2;
  const name = buffer.toString("utf8", o, o + nameLen); o += nameLen;
  return { name, value: payload(TAG.Compound) };
}

// Reads a Sponge schematic (v2 or v3, gzipped or not) into a Schem instance.
// Block entities and entities are not carried over.
export function loadSchem(filePath) {
  const raw = fs.readFileSync(filePath);
  const nbt = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  let root = parseNbt(nbt).value;
  if (root.Schematic && typeof root.Schematic === "object" && !Array.isArray(root.Schematic)) {
    root = root.Schematic; // Sponge v3 nests everything one level down
  }
  const version = root.Version ?? 2;
  const unsignedShort = (v) => (v < 0 ? v + 65536 : v);
  const width = unsignedShort(root.Width ?? 0);
  const height = unsignedShort(root.Height ?? 0);
  const length = unsignedShort(root.Length ?? 0);
  if (!width || !height || !length) {
    throw new Error(`${filePath} is not a Sponge schematic (missing dimensions)`);
  }
  const paletteTag = version >= 3 ? root.Blocks?.Palette : root.Palette;
  const dataTag = version >= 3 ? root.Blocks?.Data : root.BlockData;
  if (!paletteTag || !dataTag) {
    throw new Error(`${filePath} has no block palette/data (schematic version ${version})`);
  }

  const names = [];
  for (const [name, id] of Object.entries(paletteTag)) names[id] = name;

  const metaName = root.Metadata?.Name;
  const schem = new Schem(width, height, length, {
    name: typeof metaName === "string" ? metaName : path.basename(filePath, path.extname(filePath)),
    dataVersion: root.DataVersion ?? 3465,
    offset: root.Offset && root.Offset.length === 3 ? [...root.Offset] : [0, 0, 0],
    validate: false, // files from other game versions may name blocks we don't know
  });

  const total = width * height * length;
  let o = 0;
  for (let i = 0; i < total; i++) {
    let value = 0;
    let shift = 0;
    let b;
    do {
      if (o >= dataTag.length) {
        throw new Error(`${filePath}: BlockData ended early at block ${i} of ${total}`);
      }
      b = dataTag[o++];
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    schem.blocks[i] = names[value] ?? "minecraft:air";
  }
  return schem;
}

const FACING_CLOCKWISE = { north: "east", east: "south", south: "west", west: "north" };
const FACING_MIRROR_X = { east: "west", west: "east" };
const FACING_MIRROR_Z = { north: "south", south: "north" };
const STAIR_SHAPE_MIRROR = {
  inner_left: "inner_right",
  inner_right: "inner_left",
  outer_left: "outer_right",
  outer_right: "outer_left",
};

// Rewrites directional block states (facing, axis, stair shape) for a paste
// transform. Mirrors apply before rotation, matching the geometry order.
function transformBlockStates(name, quarters, mirrorX, mirrorZ) {
  const bracket = name.indexOf("[");
  if (bracket < 0) return name;
  const base = name.slice(0, bracket);
  const oneMirror = (mirrorX ? 1 : 0) + (mirrorZ ? 1 : 0) === 1;
  const parts = name.slice(bracket + 1, name.length - 1).split(",").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (key === "facing" && value in FACING_CLOCKWISE) {
      if (mirrorX && FACING_MIRROR_X[value]) value = FACING_MIRROR_X[value];
      if (mirrorZ && FACING_MIRROR_Z[value]) value = FACING_MIRROR_Z[value];
      for (let q = 0; q < quarters; q++) value = FACING_CLOCKWISE[value];
    } else if (key === "axis" && quarters % 2 === 1) {
      if (value === "x") value = "z";
      else if (value === "z") value = "x";
    } else if (key === "shape" && oneMirror && STAIR_SHAPE_MIRROR[value]) {
      value = STAIR_SHAPE_MIRROR[value];
    }
    return `${key}=${value}`;
  });
  return `${base}[${parts.join(",")}]`;
}

export class Schem {
  constructor(width, height, length, options = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(length)) {
      throw new Error("Schematic dimensions must be integers");
    }
    if (width <= 0 || height <= 0 || length <= 0) {
      throw new Error("Schematic dimensions must be positive");
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || length > MAX_DIMENSION) {
      throw new Error(`Schematic dimensions must be <= ${MAX_DIMENSION} (got ${width}x${height}x${length})`);
    }

    this.width = width;
    this.height = height;
    this.length = length;
    this.name = options.name ?? "Generated Schematic";
    this.dataVersion = options.dataVersion ?? 3465; // 1.20.1; see README for other versions
    this.offset = options.offset ?? [0, 0, 0];
    this.seed = options.seed ?? 0;
    this.strict = options.strict ?? false;
    // Validate block names and states against the registry on every write
    // (throws with a suggestion on typos). Off when block-data.json is absent;
    // pass { validate: false } to opt out (loadSchem does, so old files load).
    this.validate = options.validate ?? true;
    this.droppedWrites = 0;
    this.air = "minecraft:air";
    this.blocks = new Array(width * height * length).fill(this.air);
  }

  index(x, y, z) {
    return (y * this.length + z) * this.width + x;
  }

  inBounds(x, y, z) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height && z >= 0 && z < this.length;
  }

  // Internal fast path: integer coordinates, already-resolved block name.
  putResolved(x, y, z, name) {
    if (this.validate) {
      const err = blockError(name);
      if (err) throw new Error(err);
    }
    if (this.inBounds(x, y, z)) this.blocks[this.index(x, y, z)] = name;
    else this.dropWrite(x, y, z);
    return this;
  }

  dropWrite(x, y, z) {
    this.droppedWrites++;
    if (this.strict) {
      throw new Error(`Write out of bounds at (${x}, ${y}, ${z}) in a ${this.width}x${this.height}x${this.length} schematic`);
    }
  }

  set(x, y, z, name) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    const iz = Math.round(z);
    if (!this.inBounds(ix, iy, iz)) {
      this.dropWrite(ix, iy, iz);
      return this;
    }
    return this.putResolved(ix, iy, iz, block(name));
  }

  // Translated view: same drawing API, local coordinates. See Frame.
  at(x, y, z) {
    return new Frame(this, x, y, z);
  }

  get(x, y, z) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    const iz = Math.round(z);
    return this.inBounds(ix, iy, iz) ? this.blocks[this.index(ix, iy, iz)] : this.air;
  }

  setIfAir(x, y, z, name) {
    if (this.get(x, y, z) === this.air) this.set(x, y, z, name);
    return this;
  }

  paint(x, y, z, materialOrPalette) {
    return this.set(x, y, z, materialAt(materialOrPalette, x, y, z, this.seed));
  }

  // Validates a resolved palette against the registry (memoized per name).
  checkPalette(palette) {
    if (this.validate) {
      for (const name of palette) {
        const err = blockError(name);
        if (err) throw new Error(err);
      }
    }
    return palette;
  }

  fill(x1, y1, z1, x2, y2, z2, materialOrPalette) {
    const palette = this.checkPalette(paletteOf(materialOrPalette));
    const single = palette.length === 1 ? palette[0] : null;
    const ax = Math.max(0, Math.min(Math.round(x1), Math.round(x2)));
    const bx = Math.min(this.width - 1, Math.max(Math.round(x1), Math.round(x2)));
    const ay = Math.max(0, Math.min(Math.round(y1), Math.round(y2)));
    const by = Math.min(this.height - 1, Math.max(Math.round(y1), Math.round(y2)));
    const az = Math.max(0, Math.min(Math.round(z1), Math.round(z2)));
    const bz = Math.min(this.length - 1, Math.max(Math.round(z1), Math.round(z2)));

    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        const base = (y * this.length + z) * this.width;
        for (let x = ax; x <= bx; x++) {
          this.blocks[base + x] = single ?? pick(palette, x, y, z, this.seed);
        }
      }
    }
    return this;
  }

  // Alias kept for compatibility; fill() accepts palettes directly.
  fillPalette(x1, y1, z1, x2, y2, z2, materialOrPalette) {
    return this.fill(x1, y1, z1, x2, y2, z2, materialOrPalette);
  }

  hollowBox(x1, y1, z1, x2, y2, z2, materialOrPalette, thickness = 1) {
    const palette = paletteOf(materialOrPalette);
    const single = palette.length === 1 ? palette[0] : null;
    const ax = Math.min(Math.round(x1), Math.round(x2));
    const bx = Math.max(Math.round(x1), Math.round(x2));
    const ay = Math.min(Math.round(y1), Math.round(y2));
    const by = Math.max(Math.round(y1), Math.round(y2));
    const az = Math.min(Math.round(z1), Math.round(z2));
    const bz = Math.max(Math.round(z1), Math.round(z2));
    const t = Math.max(1, Math.round(thickness));

    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        for (let x = ax; x <= bx; x++) {
          const onFace =
            x - ax < t || bx - x < t ||
            y - ay < t || by - y < t ||
            z - az < t || bz - z < t;
          if (onFace) this.putResolved(x, y, z, single ?? pick(palette, x, y, z, this.seed));
        }
      }
    }
    return this;
  }

  // Places a ball of the given radius at a (possibly fractional) point.
  stampBall(x, y, z, radius, palette) {
    for (let oy = -radius; oy <= radius; oy++) {
      for (let oz = -radius; oz <= radius; oz++) {
        for (let ox = -radius; ox <= radius; ox++) {
          if (ox * ox + oy * oy + oz * oz <= radius * radius + 0.25) {
            const ix = Math.round(x + ox);
            const iy = Math.round(y + oy);
            const iz = Math.round(z + oz);
            this.putResolved(ix, iy, iz, palette.length === 1 ? palette[0] : pick(palette, ix, iy, iz, this.seed));
          }
        }
      }
    }
    return this;
  }

  line(x1, y1, z1, x2, y2, z2, materialOrPalette, radius = 0) {
    const palette = paletteOf(materialOrPalette);
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), Math.abs(z2 - z1)) * 1.75);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      this.stampBall(
        x1 + (x2 - x1) * t,
        y1 + (y2 - y1) * t,
        z1 + (z2 - z1) * t,
        radius,
        palette,
      );
    }
    return this;
  }

  // Semicircular arch between two feet. The apex rises `options.rise` blocks
  // above the midpoint (default: half the span, i.e. a true semicircle).
  // options.radius is the beam thickness, like line().
  arch(x1, y1, z1, x2, y2, z2, materialOrPalette, options = {}) {
    const palette = paletteOf(materialOrPalette);
    const beam = options.radius ?? 0;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const halfSpan = Math.hypot(dx, dy, dz) / 2;
    const rise = options.rise ?? halfSpan;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const mz = (z1 + z2) / 2;
    const steps = Math.max(8, Math.ceil((halfSpan + Math.abs(rise)) * 3));
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI;
      const along = Math.cos(theta);
      const up = Math.sin(theta) * rise;
      this.stampBall(
        mx + (dx / 2) * along,
        my + (dy / 2) * along + up,
        mz + (dz / 2) * along,
        beam,
        palette,
      );
    }
    return this;
  }

  frustumY(cx, cz, y1, y2, radius1, radius2, materialOrPalette, options = {}) {
    const palette = paletteOf(materialOrPalette);
    const minY = Math.min(Math.round(y1), Math.round(y2));
    const maxY = Math.max(Math.round(y1), Math.round(y2));
    const shell = options.shell ?? false;
    const noise = options.noise ?? 0;
    const maxRadius = Math.max(radius1, radius2) + Math.abs(noise) + 1;
    const x0 = Math.max(0, Math.floor(cx - maxRadius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + maxRadius));
    const z0 = Math.max(0, Math.floor(cz - maxRadius));
    const z1 = Math.min(this.length - 1, Math.ceil(cz + maxRadius));
    const yStart = Math.max(0, minY);
    const yEnd = Math.min(this.height - 1, maxY);

    for (let y = yStart; y <= yEnd; y++) {
      const t = maxY === minY ? 0 : (y - minY) / (maxY - minY);
      const radius = radius1 + (radius2 - radius1) * t;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, z - cz);
          const edge = radius + (hash3(x, y, z, this.seed) - 0.5) * noise;
          const inside = shell
            ? d <= edge && d >= Math.max(0, edge - (options.thickness ?? 1.5))
            : d <= edge;
          if (inside) this.putResolved(x, y, z, pick(palette, x, y, z, this.seed));
        }
      }
    }
    return this;
  }

  sphere(cx, cy, cz, radius, materialOrPalette, options = {}) {
    return this.ellipsoid(cx, cy, cz, radius, radius, radius, materialOrPalette, options);
  }

  // options.yaw / pitch / roll (degrees) tilt the ellipsoid: yaw spins it
  // around Y (90 = the same quarter-turn as paste's rotate: 1), pitch tips the
  // top toward +Z, roll tips it toward +X. Applied roll, then pitch, then yaw.
  ellipsoid(cx, cy, cz, rx, ry, rz, materialOrPalette, options = {}) {
    const solid = options.solid ?? true;
    const noise = options.noise ?? 0;
    const palette = paletteOf(materialOrPalette);
    const yaw = ((options.yaw ?? 0) * Math.PI) / 180;
    const pitch = ((options.pitch ?? 0) * Math.PI) / 180;
    const roll = ((options.roll ?? 0) * Math.PI) / 180;
    const rotated = yaw !== 0 || pitch !== 0 || roll !== 0;
    const rMax = Math.max(rx, ry, rz);
    const bx = rotated ? rMax : rx;
    const by = rotated ? rMax : ry;
    const bz = rotated ? rMax : rz;
    // inverse rotation: undo yaw (around Y), then pitch (around X), then roll (around Z)
    const cyw = Math.cos(-yaw), syw = Math.sin(-yaw);
    const cpt = Math.cos(-pitch), spt = Math.sin(-pitch);
    const crl = Math.cos(-roll), srl = Math.sin(-roll);
    let yLo = Math.floor(cy - by - 1);
    let yHi = Math.ceil(cy + by + 1);
    if (options.minY != null) yLo = Math.max(yLo, Math.ceil(options.minY));
    if (options.maxY != null) yHi = Math.min(yHi, Math.floor(options.maxY));
    yLo = Math.max(0, yLo);
    yHi = Math.min(this.height - 1, yHi);
    const z0 = Math.max(0, Math.floor(cz - bz - 1));
    const z1 = Math.min(this.length - 1, Math.ceil(cz + bz + 1));
    const x0 = Math.max(0, Math.floor(cx - bx - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + bx + 1));

    for (let y = yLo; y <= yHi; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          let dx = x - cx, dy = y - cy, dz = z - cz;
          if (rotated) {
            let tx = dx * cyw - dz * syw;
            let tz = dx * syw + dz * cyw;
            let ty = dy * cpt - tz * spt;
            tz = dy * spt + tz * cpt;
            dx = tx * crl + ty * srl;
            dy = ty * crl - tx * srl;
            dz = tz;
          }
          const d = (dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2;
          const n = (hash3(x, y, z, this.seed) - 0.5) * noise;
          if (solid ? d <= 1 + n : d <= 1 + n && d >= (options.shellMin ?? 0.64) + n) {
            this.putResolved(x, y, z, pick(palette, x, y, z, this.seed));
          }
        }
      }
    }
    return this;
  }

  // Upper half of an ellipsoid shell, for roofs. The base is always at cy.
  // Pass { solid: true } for a filled dome; shellMin controls shell thickness.
  dome(cx, cy, cz, rx, ry, rz, materialOrPalette, options = {}) {
    return this.ellipsoid(cx, cy, cz, rx, ry, rz, materialOrPalette, {
      solid: false,
      ...options,
      minY: cy,
    });
  }

  cylinderY(cx, cz, y1, y2, radius, materialOrPalette, options = {}) {
    const palette = paletteOf(materialOrPalette);
    const noise = options.noise ?? 0;
    const yStart = Math.max(0, Math.round(Math.min(y1, y2)));
    const yEnd = Math.min(this.height - 1, Math.round(Math.max(y1, y2)));
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 1));
    const z0 = Math.max(0, Math.floor(cz - radius - 1));
    const z1 = Math.min(this.length - 1, Math.ceil(cz + radius + 1));

    for (let y = yStart; y <= yEnd; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (Math.hypot(x - cx, z - cz) <= radius + (hash3(x, y, z, this.seed) - 0.5) * noise) {
            this.putResolved(x, y, z, pick(palette, x, y, z, this.seed));
          }
        }
      }
    }
    return this;
  }

  // Single-layer horizontal disc (ponds, plazas, tower floors).
  discY(cx, cz, y, radius, materialOrPalette, options = {}) {
    return this.cylinderY(cx, cz, y, y, radius, materialOrPalette, options);
  }

  // Torus (ring). majorRadius is the distance from the center to the middle of
  // the tube; minorRadius is the tube's own radius. options.axis picks the
  // axis the ring wraps around: "y" (default) lays it flat, "x" / "z" stand it
  // upright. options.noise roughens the surface like the other shapes.
  torus(cx, cy, cz, majorRadius, minorRadius, materialOrPalette, options = {}) {
    const palette = paletteOf(materialOrPalette);
    const axis = options.axis ?? "y";
    if (axis !== "x" && axis !== "y" && axis !== "z") {
      throw new Error(`Unknown torus axis "${axis}" (expected "x", "y" or "z")`);
    }
    const noise = options.noise ?? 0;
    const ring = majorRadius + minorRadius + Math.abs(noise) + 1;
    const tube = minorRadius + Math.abs(noise) + 1;
    const bx = axis === "x" ? tube : ring;
    const by = axis === "y" ? tube : ring;
    const bz = axis === "z" ? tube : ring;
    const x0 = Math.max(0, Math.floor(cx - bx));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + bx));
    const y0 = Math.max(0, Math.floor(cy - by));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + by));
    const z0 = Math.max(0, Math.floor(cz - bz));
    const z1 = Math.min(this.length - 1, Math.ceil(cz + bz));

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy, dz = z - cz;
          let inPlane, along;
          if (axis === "y") { inPlane = Math.hypot(dx, dz); along = dy; }
          else if (axis === "x") { inPlane = Math.hypot(dy, dz); along = dx; }
          else { inPlane = Math.hypot(dx, dy); along = dz; }
          const d = Math.hypot(inPlane - majorRadius, along);
          if (d <= minorRadius + (hash3(x, y, z, this.seed) - 0.5) * noise) {
            this.putResolved(x, y, z, pick(palette, x, y, z, this.seed));
          }
        }
      }
    }
    return this;
  }

  // Stamps another Schem into this one at the given offset. Air cells in the
  // source are skipped unless options.skipAir is false. options.rotate turns
  // the module 0-3 quarter-turns clockwise (viewed from above); mirrorX /
  // mirrorZ flip it first. Directional block states (facing, axis, stair
  // shape) rotate and mirror with the geometry.
  paste(other, dx = 0, dy = 0, dz = 0, options = {}) {
    if (!(other instanceof Schem)) throw new Error("paste expects a Schem instance");
    const skipAir = options.skipAir ?? true;
    const quarters = ((Math.round(options.rotate ?? 0) % 4) + 4) % 4;
    const mirrorX = options.mirrorX ?? false;
    const mirrorZ = options.mirrorZ ?? false;
    const ox = Math.round(dx);
    const oy = Math.round(dy);
    const oz = Math.round(dz);
    const transformed = new Map();
    const nameFor = (name) => {
      let t = transformed.get(name);
      if (t === undefined) {
        t = quarters || mirrorX || mirrorZ ? transformBlockStates(name, quarters, mirrorX, mirrorZ) : name;
        transformed.set(name, t);
      }
      return t;
    };

    for (let y = 0; y < other.height; y++) {
      for (let z = 0; z < other.length; z++) {
        for (let x = 0; x < other.width; x++) {
          const name = other.blocks[other.index(x, y, z)];
          if (skipAir && name === other.air) continue;
          let tx = mirrorX ? other.width - 1 - x : x;
          let tz = mirrorZ ? other.length - 1 - z : z;
          let tw = other.width;
          let tl = other.length;
          for (let q = 0; q < quarters; q++) {
            const rotated = tl - 1 - tz;
            tz = tx;
            tx = rotated;
            const swap = tw;
            tw = tl;
            tl = swap;
          }
          this.putResolved(ox + tx, oy + y, oz + tz, nameFor(name));
        }
      }
    }
    return this;
  }

  // Stamp ASCII floor plans, one layer per Y level, bottom-up. Rows run
  // north->south (z), columns west->east (x) — the same orientation as the
  // `top` preview and sliceText("y", ...). The legend maps single characters
  // to a block, a palette array, or null to skip; "." and " " skip by default.
  // Map a character to "air" to carve.
  stampLayers(x0, y0, z0, legend, layers) {
    const resolved = new Map([[".", null], [" ", null]]);
    for (const [ch, material] of Object.entries(legend)) {
      if (ch.length !== 1) throw new Error(`stampLayers legend keys must be single characters (got "${ch}")`);
      resolved.set(ch, material == null ? null : paletteOf(material));
    }
    const bx = Math.round(x0);
    const by = Math.round(y0);
    const bz = Math.round(z0);
    layers.forEach((rows, ly) => {
      rows.forEach((row, rz) => {
        for (let rx = 0; rx < row.length; rx++) {
          const palette = resolved.get(row[rx]);
          if (palette === undefined) {
            throw new Error(`stampLayers: character "${row[rx]}" (layer ${ly}, row ${rz}, column ${rx}) is not in the legend`);
          }
          if (palette === null) continue;
          const x = bx + rx;
          const y = by + ly;
          const z = bz + rz;
          this.putResolved(x, y, z, palette.length === 1 ? palette[0] : pick(palette, x, y, z, this.seed));
        }
      });
    });
    return this;
  }

  // ASCII slice for quick text inspection. Orientation matches the preview
  // views: y-slices match `top`, z-slices match `front`, x-slices match `left`.
  sliceText(axis, index, options = {}) {
    const trim = options.trim ?? true;
    const i = Math.round(index);
    let rows, cols, blockAt, describe;
    if (axis === "y") {
      if (i < 0 || i >= this.height) return `y=${i} is outside 0..${this.height - 1}`;
      rows = this.length;
      cols = this.width;
      blockAt = (r, c) => this.blocks[this.index(c, i, r)];
      describe = (r0, r1, c0, c1) =>
        `y=${i} slice (matches the top view): rows z=${r0}..${r1} north->south, columns x=${c0}..${c1} west->east`;
    } else if (axis === "z") {
      if (i < 0 || i >= this.length) return `z=${i} is outside 0..${this.length - 1}`;
      rows = this.height;
      cols = this.width;
      blockAt = (r, c) => this.blocks[this.index(c, this.height - 1 - r, i)];
      describe = (r0, r1, c0, c1) =>
        `z=${i} slice (matches the front view): rows y=${this.height - 1 - r0}..${this.height - 1 - r1} top->bottom, columns x=${c0}..${c1} west->east`;
    } else if (axis === "x") {
      if (i < 0 || i >= this.width) return `x=${i} is outside 0..${this.width - 1}`;
      rows = this.height;
      cols = this.length;
      blockAt = (r, c) => this.blocks[this.index(i, this.height - 1 - r, c)];
      describe = (r0, r1, c0, c1) =>
        `x=${i} slice (matches the left view): rows y=${this.height - 1 - r0}..${this.height - 1 - r1} top->bottom, columns z=${c0}..${c1} north->south`;
    } else {
      throw new Error(`sliceText axis must be "x", "y", or "z" (got "${axis}")`);
    }

    let r0 = 0, r1 = rows - 1, c0 = 0, c1 = cols - 1;
    if (trim) {
      r0 = rows; r1 = -1; c0 = cols; c1 = -1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (blockAt(r, c) !== this.air) {
            if (r < r0) r0 = r;
            if (r > r1) r1 = r;
            if (c < c0) c0 = c;
            if (c > c1) c1 = c;
          }
        }
      }
      if (r1 < 0) return `${axis}=${i} slice: all air`;
    }

    const counts = new Map();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const name = blockAt(r, c);
        if (name !== this.air) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const CHARS = "#o+x*=%@&$abcdefghijkmnpqrstuvwyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const charFor = new Map();
    ranked.forEach(([name], idx) => charFor.set(name, CHARS[idx] ?? "?"));

    const lines = [describe(r0, r1, c0, c1)];
    for (let r = r0; r <= r1; r++) {
      let line = "";
      for (let c = c0; c <= c1; c++) {
        const name = blockAt(r, c);
        line += name === this.air ? "." : charFor.get(name);
      }
      lines.push(line);
    }
    lines.push("");
    for (const [name, count] of ranked) {
      lines.push(`${charFor.get(name)} = ${name} (${count})`);
    }
    if (ranked.length > CHARS.length) lines.push(`? = ${ranked.length - CHARS.length} more block types`);
    return lines.join("\n");
  }

  stats() {
    const counts = new Map();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let i = 0;
    for (let y = 0; y < this.height; y++) {
      for (let z = 0; z < this.length; z++) {
        for (let x = 0; x < this.width; x++, i++) {
          const name = this.blocks[i];
          counts.set(name, (counts.get(name) ?? 0) + 1);
          if (name !== this.air) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
      }
    }
    const nonAir = this.blocks.length - (counts.get(this.air) ?? 0);
    return {
      width: this.width,
      height: this.height,
      length: this.length,
      blockCount: this.blocks.length,
      nonAir,
      droppedWrites: this.droppedWrites,
      bounds: nonAir ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null,
      paletteSize: counts.size,
      topBlocks: [...counts.entries()]
        .filter(([name]) => name !== this.air)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16),
    };
  }

  toNbtBuffer() {
    const palette = new Map();
    const paletteEntries = [];
    const ids = new Uint32Array(this.blocks.length);
    for (let i = 0; i < this.blocks.length; i++) {
      const name = this.blocks[i];
      let id = palette.get(name);
      if (id === undefined) {
        id = palette.size;
        palette.set(name, id);
        paletteEntries.push(name);
      }
      ids[i] = id;
    }

    const varints = paletteEntries.map((_, id) => encodeVarInt(id));
    let totalBytes = 0;
    for (let i = 0; i < ids.length; i++) totalBytes += varints[ids[i]].length;
    const blockData = Buffer.allocUnsafe(totalBytes);
    let o = 0;
    for (let i = 0; i < ids.length; i++) {
      const bytes = varints[ids[i]];
      for (let j = 0; j < bytes.length; j++) blockData[o++] = bytes[j];
    }

    const writer = new NbtWriter();
    writer.ubyte(TAG.Compound);
    writer.stringPayload("Schematic");
    writer.namedTag(TAG.Int, "Version", () => writer.int(2));
    writer.namedTag(TAG.Int, "DataVersion", () => writer.int(this.dataVersion));
    writer.namedTag(TAG.Short, "Width", () => writer.short(this.width));
    writer.namedTag(TAG.Short, "Height", () => writer.short(this.height));
    writer.namedTag(TAG.Short, "Length", () => writer.short(this.length));
    writer.namedTag(TAG.IntArray, "Offset", () => {
      writer.int(3);
      writer.int(this.offset[0] ?? 0);
      writer.int(this.offset[1] ?? 0);
      writer.int(this.offset[2] ?? 0);
    });
    writer.namedTag(TAG.Int, "PaletteMax", () => writer.int(paletteEntries.length));
    writer.namedTag(TAG.Compound, "Palette", () => {
      for (let i = 0; i < paletteEntries.length; i++) {
        writer.namedTag(TAG.Int, paletteEntries[i], () => writer.int(i));
      }
      writer.end();
    });
    writer.namedTag(TAG.ByteArray, "BlockData", () => {
      writer.int(blockData.length);
      writer.push(blockData);
    });
    writer.namedTag(TAG.List, "BlockEntities", () => {
      writer.ubyte(TAG.Compound);
      writer.int(0);
    });
    writer.namedTag(TAG.List, "Entities", () => {
      writer.ubyte(TAG.Compound);
      writer.int(0);
    });
    writer.namedTag(TAG.Compound, "Metadata", () => {
      writer.namedTag(TAG.Int, "WEOffsetX", () => writer.int(this.offset[0] ?? 0));
      writer.namedTag(TAG.Int, "WEOffsetY", () => writer.int(this.offset[1] ?? 0));
      writer.namedTag(TAG.Int, "WEOffsetZ", () => writer.int(this.offset[2] ?? 0));
      writer.namedTag(TAG.String, "Name", () => writer.stringPayload(this.name));
      writer.end();
    });
    writer.end();
    return writer.buffer();
  }

  toSchemBuffer() {
    return zlib.gzipSync(this.toNbtBuffer(), { level: 9 });
  }

  save(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.toSchemBuffer());
    return this;
  }
}

// A translated view of a Schem: the same drawing API, but coordinates are
// local to the frame's origin. Created with schem.at(x, y, z); frames nest.
export class Frame {
  constructor(schem, ox, oy, oz) {
    this.schem = schem;
    this.ox = Math.round(ox);
    this.oy = Math.round(oy);
    this.oz = Math.round(oz);
  }

  at(dx, dy, dz) { return new Frame(this.schem, this.ox + dx, this.oy + dy, this.oz + dz); }
  set(x, y, z, name) { this.schem.set(x + this.ox, y + this.oy, z + this.oz, name); return this; }
  get(x, y, z) { return this.schem.get(x + this.ox, y + this.oy, z + this.oz); }
  setIfAir(x, y, z, name) { this.schem.setIfAir(x + this.ox, y + this.oy, z + this.oz, name); return this; }
  paint(x, y, z, m) { this.schem.paint(x + this.ox, y + this.oy, z + this.oz, m); return this; }
  fill(x1, y1, z1, x2, y2, z2, m) { this.schem.fill(x1 + this.ox, y1 + this.oy, z1 + this.oz, x2 + this.ox, y2 + this.oy, z2 + this.oz, m); return this; }
  fillPalette(x1, y1, z1, x2, y2, z2, m) { return this.fill(x1, y1, z1, x2, y2, z2, m); }
  hollowBox(x1, y1, z1, x2, y2, z2, m, t) { this.schem.hollowBox(x1 + this.ox, y1 + this.oy, z1 + this.oz, x2 + this.ox, y2 + this.oy, z2 + this.oz, m, t); return this; }
  line(x1, y1, z1, x2, y2, z2, m, r) { this.schem.line(x1 + this.ox, y1 + this.oy, z1 + this.oz, x2 + this.ox, y2 + this.oy, z2 + this.oz, m, r); return this; }
  arch(x1, y1, z1, x2, y2, z2, m, o) { this.schem.arch(x1 + this.ox, y1 + this.oy, z1 + this.oz, x2 + this.ox, y2 + this.oy, z2 + this.oz, m, o); return this; }

  sphere(cx, cy, cz, r, m, o) { return this.ellipsoid(cx, cy, cz, r, r, r, m, o); }

  ellipsoid(cx, cy, cz, rx, ry, rz, m, o = {}) {
    const opts = { ...o };
    if (opts.minY != null) opts.minY += this.oy;
    if (opts.maxY != null) opts.maxY += this.oy;
    this.schem.ellipsoid(cx + this.ox, cy + this.oy, cz + this.oz, rx, ry, rz, m, opts);
    return this;
  }

  dome(cx, cy, cz, rx, ry, rz, m, o = {}) {
    const opts = { ...o };
    if (opts.maxY != null) opts.maxY += this.oy;
    this.schem.dome(cx + this.ox, cy + this.oy, cz + this.oz, rx, ry, rz, m, opts);
    return this;
  }

  cylinderY(cx, cz, y1, y2, r, m, o) { this.schem.cylinderY(cx + this.ox, cz + this.oz, y1 + this.oy, y2 + this.oy, r, m, o); return this; }
  discY(cx, cz, y, r, m, o) { this.schem.discY(cx + this.ox, cz + this.oz, y + this.oy, r, m, o); return this; }
  torus(cx, cy, cz, R, r, m, o) { this.schem.torus(cx + this.ox, cy + this.oy, cz + this.oz, R, r, m, o); return this; }
  frustumY(cx, cz, y1, y2, r1, r2, m, o) { this.schem.frustumY(cx + this.ox, cz + this.oz, y1 + this.oy, y2 + this.oy, r1, r2, m, o); return this; }
  stampLayers(x, y, z, legend, layers) { this.schem.stampLayers(x + this.ox, y + this.oy, z + this.oz, legend, layers); return this; }
  paste(other, dx = 0, dy = 0, dz = 0, o) { this.schem.paste(other, dx + this.ox, dy + this.oy, dz + this.oz, o); return this; }
}

export function buildExample() {
  const s = new Schem(64, 48, 64, { name: "schem-builder example" });
  s.fill(0, 0, 0, 63, 0, 63, blocks.grass);
  s.fill(20, 1, 20, 44, 10, 44, blocks.oakPlanks);
  s.fill(22, 2, 22, 42, 9, 42, blocks.air);
  s.fill(20, 11, 20, 44, 11, 44, blocks.darkOakPlanks);
  s.fill(24, 2, 19, 30, 7, 19, blocks.glass);
  s.fill(34, 2, 19, 40, 7, 19, blocks.glass);
  s.fill(30, 1, 20, 34, 5, 20, blocks.air);
  s.cylinderY(32, 32, 1, 18, 4, [blocks.oakLog, blocks.darkOakLog], { noise: 0.3 });
  s.ellipsoid(32, 28, 32, 15, 11, 15, [blocks.oakLeaves, blocks.jungleLeaves, blocks.azaleaLeaves], { noise: 0.18 });
  s.line(6, 1, 6, 25, 16, 25, blocks.gold, 1);
  s.sphere(6, 1, 6, 3, blocks.blackstone);
  return s;
}

export async function runSceneModule(modulePath) {
  const mod = await import(pathToFileURL(path.resolve(modulePath)).href);
  const prefabs = await import(new URL("./prefabs.mjs", import.meta.url).href);
  const builder = mod.default ?? mod.build;
  if (typeof builder !== "function") {
    throw new Error(`${modulePath} must export default function or named build function`);
  }
  return builder({ Schem, block, blocks, withState, stairs, hash3, pick, paletteOf, materialAt, loadSchem, prefabs, blockColor, nearestBlock, gradient, blockError, registryInfo });
}

// Loads a .schem file or runs a scene module, returning a Schem.
export async function loadInput(filePath) {
  if (filePath.toLowerCase().endsWith(".schem")) return loadSchem(filePath);
  const result = await runSceneModule(filePath);
  const schem = result instanceof Schem ? result : result?.schem;
  if (!(schem instanceof Schem)) throw new Error(`${filePath} did not produce a Schem instance`);
  return schem;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const [arg1, arg2] = rest;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  node schem-builder.mjs example <out.schem>
  node schem-builder.mjs run <scene.mjs> <out.schem>
  node schem-builder.mjs stats <file.schem>
  node schem-builder.mjs slice <scene.mjs|file.schem> y=6 [x=3 z=4 ...] [--full]
  node schem-builder.mjs nearest <#rrggbb|block_name> [count] [--all]

Scene modules should export:
  export default function ({ Schem, blocks, block, withState, stairs, prefabs, pick, hash3, nearestBlock, gradient, blockColor }) { return new Schem(...); }
`);
    return;
  }

  if (cmd === "example") {
    const out = arg1 ?? path.resolve("example.schem");
    const schem = buildExample();
    schem.save(out);
    console.log(JSON.stringify({ out, ...schem.stats() }, null, 2));
    return;
  }

  if (cmd === "run") {
    if (!arg1 || !arg2) throw new Error("Usage: node schem-builder.mjs run <scene.mjs> <out.schem>");
    const result = await runSceneModule(arg1);
    const schem = result instanceof Schem ? result : result?.schem;
    if (!(schem instanceof Schem)) throw new Error("Scene module did not return a Schem instance");
    schem.save(arg2);
    console.log(JSON.stringify({ out: arg2, ...schem.stats() }, null, 2));
    return;
  }

  if (cmd === "stats") {
    if (!arg1) throw new Error("Usage: node schem-builder.mjs stats <file.schem>");
    const schem = loadSchem(arg1);
    console.log(JSON.stringify({
      file: arg1,
      name: schem.name,
      dataVersion: schem.dataVersion,
      offset: schem.offset,
      ...schem.stats(),
    }, null, 2));
    return;
  }

  if (cmd === "slice") {
    const [file, ...specArgs] = rest;
    const specs = specArgs.filter((a) => a !== "--full");
    if (!file || !specs.length) {
      throw new Error("Usage: node schem-builder.mjs slice <scene.mjs|file.schem> y=6 [x=3 z=4 ...] [--full]");
    }
    const trim = !specArgs.includes("--full");
    const schem = await loadInput(file);
    const out = specs.map((spec) => {
      const m = /^([xyz])=(-?\d+)$/.exec(spec);
      if (!m) throw new Error(`slice spec must look like y=6 (got "${spec}")`);
      return schem.sliceText(m[1], Number(m[2]), { trim });
    });
    console.log(out.join("\n\n"));
    return;
  }

  if (cmd === "nearest") {
    if (!arg1) throw new Error("Usage: node schem-builder.mjs nearest <#rrggbb|r,g,b|block_name> [count] [--all]");
    const target = /^\d+,\d+,\d+$/.test(arg1) ? arg1.split(",").map(Number) : arg1;
    const count = Number.isInteger(Number(arg2)) && Number(arg2) > 0 ? Number(arg2) : 8;
    const names = nearestBlock(target, { count, all: rest.includes("--all") });
    for (const name of names) {
      const c = blockColor(name);
      console.log(`${name}  rgb(${c.join(", ")})`);
    }
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
