// Prefabs: higher-level building parts assembled from schem-builder
// primitives. Every function takes the target Schem (or Frame) as its first
// argument and uses only the public drawing API, so prefabs work inside local
// frames too.

import { Schem, block, blocks, paletteOf, hash3, stairs, withState } from "./schem-builder.mjs";

const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

// Classic gable (A-frame) roof over a rectangular footprint. The ridge runs
// along options.axis ("x" or "z"; default: the longer side). Slopes are stairs
// of options.material — a stem like "oak" or "stone_brick", same as stairs().
// An odd span gets a slab ridge (options.ridge overrides the block).
// options.gable fills the triangular end walls with a block or palette.
export function gableRoof(s, x1, z1, x2, z2, y, options = {}) {
  const ax = Math.min(Math.round(x1), Math.round(x2));
  const bx = Math.max(Math.round(x1), Math.round(x2));
  const az = Math.min(Math.round(z1), Math.round(z2));
  const bz = Math.max(Math.round(z1), Math.round(z2));
  const y0 = Math.round(y);
  const stem = options.material ?? "oak";
  const stemBase = block(stem).replace(/_stairs$/, "");
  const axis = options.axis ?? (bx - ax >= bz - az ? "x" : "z");
  const ridge = options.ridge ?? withState(`${stemBase}_slab`, { type: "bottom" });

  if (axis === "x") {
    for (let o = 0; ; o++) {
      const yo = y0 + o;
      const zn = az + o;
      const zs = bz - o;
      if (zn > zs) break;
      if (zn === zs) {
        for (let x = ax; x <= bx; x++) s.set(x, yo, zn, ridge);
        break;
      }
      for (let x = ax; x <= bx; x++) {
        s.set(x, yo, zn, stairs(stem, "south"));
        s.set(x, yo, zs, stairs(stem, "north"));
      }
      if (options.gable) {
        for (let z = zn + 1; z <= zs - 1; z++) {
          s.paint(ax, yo, z, options.gable);
          s.paint(bx, yo, z, options.gable);
        }
      }
    }
  } else {
    for (let o = 0; ; o++) {
      const yo = y0 + o;
      const xw = ax + o;
      const xe = bx - o;
      if (xw > xe) break;
      if (xw === xe) {
        for (let z = az; z <= bz; z++) s.set(xw, yo, z, ridge);
        break;
      }
      for (let z = az; z <= bz; z++) {
        s.set(xw, yo, z, stairs(stem, "east"));
        s.set(xe, yo, z, stairs(stem, "west"));
      }
      if (options.gable) {
        for (let x = xw + 1; x <= xe - 1; x++) {
          s.paint(x, yo, az, options.gable);
          s.paint(x, yo, bz, options.gable);
        }
      }
    }
  }
  return s;
}

// Straight staircase ascending toward `direction`, one block up per step,
// stairs faced correctly. options.width widens it perpendicular to travel;
// options.support is "none" (default), "under" (one block beneath each step)
// or "solid" (fill down to the start level), using options.supportMaterial
// (default cobblestone).
export function stairRun(s, x, y, z, direction, steps, material = "oak", options = {}) {
  const dir = DIRECTIONS[direction];
  if (!dir) throw new Error(`stairRun direction must be one of ${Object.keys(DIRECTIONS).join(", ")}`);
  const width = Math.max(1, Math.round(options.width ?? 1));
  const support = options.support ?? "none";
  const supportMaterial = options.supportMaterial ?? "cobblestone";
  const [dx, dz] = dir;
  const [px, pz] = dx === 0 ? [1, 0] : [0, 1];
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const z0 = Math.round(z);

  for (let i = 0; i < steps; i++) {
    for (let w = 0; w < width; w++) {
      const sx = x0 + dx * i + px * w;
      const sy = y0 + i;
      const sz = z0 + dz * i + pz * w;
      s.set(sx, sy, sz, stairs(material, direction));
      if (support === "under") {
        s.paint(sx, sy - 1, sz, supportMaterial);
      } else if (support === "solid") {
        for (let yy = sy - 1; yy >= y0; yy--) s.paint(sx, yy, sz, supportMaterial);
      }
    }
  }
  return s;
}

// Simple parameterized trees. Styles: "oak" (round crown), "spruce" (cone).
// Size varies deterministically per position and schematic seed; override with
// options.height / options.radius. options.log / options.leaves swap materials.
export function tree(s, x, y, z, options = {}) {
  const style = options.style ?? "oak";
  const seed = s.seed ?? s.schem?.seed ?? 0;
  const vary = (salt, lo, hi) => lo + hash3(x, z, salt, seed) * (hi - lo);

  if (style === "oak") {
    const height = Math.round(options.height ?? vary(1, 4, 7));
    const radius = options.radius ?? vary(2, 2.4, 3.6);
    s.ellipsoid(x, y + height, z, radius, Math.max(2, radius * 0.85), radius,
      options.leaves ?? [blocks.oakLeaves, blocks.oakLeaves, blocks.azaleaLeaves], { noise: 0.25 });
    s.cylinderY(x, z, y, y + height - 1, 0.8, options.log ?? blocks.oakLog);
  } else if (style === "spruce") {
    const height = Math.round(options.height ?? vary(1, 8, 12));
    const radius = options.radius ?? vary(2, 2.2, 3.2);
    s.frustumY(x, z, y + 2, y + height, radius, 0.4, options.leaves ?? blocks.spruceLeaves, { noise: 0.3 });
    s.cylinderY(x, z, y, y + 1, 0.4, options.log ?? blocks.spruceLog);
  } else {
    throw new Error(`Unknown tree style "${style}" (expected "oak" or "spruce")`);
  }
  return s;
}

// Column height grid for terrain. Heights are the Y level of the surface block.
export class Heightmap {
  constructor(width, length, base = 0) {
    this.width = width;
    this.length = length;
    this.data = new Float32Array(width * length).fill(base);
  }

  get(x, z) {
    const cx = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const cz = Math.max(0, Math.min(this.length - 1, Math.round(z)));
    return this.data[cz * this.width + cx];
  }

  set(x, z, height) {
    const cx = Math.round(x);
    const cz = Math.round(z);
    if (cx >= 0 && cx < this.width && cz >= 0 && cz < this.length) {
      this.data[cz * this.width + cx] = height;
    }
    return this;
  }

  // Rounded surface Y — place things at surfaceY(x, z) + 1 to sit on the ground.
  surfaceY(x, z) {
    return Math.round(this.get(x, z));
  }

  // Rolling terrain from layered smooth value noise. Deterministic per seed.
  static fromNoise(width, length, options = {}) {
    const { base = 4, amplitude = 4, scale = 12, octaves = 3, seed = 0 } = options;
    const hm = new Heightmap(width, length);
    const smooth = (t) => t * t * (3 - 2 * t);
    const layer = (x, z, cell, layerSeed) => {
      const gx = x / cell;
      const gz = z / cell;
      const gx0 = Math.floor(gx);
      const gz0 = Math.floor(gz);
      const tx = smooth(gx - gx0);
      const tz = smooth(gz - gz0);
      const v00 = hash3(gx0, gz0, 71, layerSeed);
      const v10 = hash3(gx0 + 1, gz0, 71, layerSeed);
      const v01 = hash3(gx0, gz0 + 1, 71, layerSeed);
      const v11 = hash3(gx0 + 1, gz0 + 1, 71, layerSeed);
      return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
    };
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        let value = 0;
        let amp = 1;
        let cell = scale;
        let norm = 0;
        for (let o = 0; o < octaves; o++) {
          value += (layer(x, z, cell, seed + o * 101) - 0.5) * amp;
          norm += amp;
          amp *= 0.5;
          cell = Math.max(2, cell / 2);
        }
        hm.data[z * width + x] = base + (value / norm) * 2 * amplitude;
      }
    }
    return hm;
  }

  // Paints the terrain into a schematic: options.top at the surface,
  // options.under below it for options.depth blocks, and options.base (if set)
  // from there down to y=0.
  paintTo(s, options = {}) {
    if (!(s instanceof Schem)) throw new Error("Heightmap.paintTo needs a Schem (not a Frame)");
    const top = paletteOf(options.top ?? blocks.grass);
    const under = paletteOf(options.under ?? blocks.dirt);
    const base = options.base ? paletteOf(options.base) : null;
    const depth = Math.max(0, Math.round(options.depth ?? 3));
    const width = Math.min(this.width, s.width);
    const length = Math.min(this.length, s.length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const surface = Math.max(0, Math.min(s.height - 1, this.surfaceY(x, z)));
        s.paint(x, surface, z, top);
        const underTo = Math.max(0, surface - depth);
        for (let y = surface - 1; y >= underTo; y--) s.paint(x, y, z, under);
        if (base) {
          for (let y = underTo - 1; y >= 0; y--) s.paint(x, y, z, base);
        }
      }
    }
    return this;
  }
}
