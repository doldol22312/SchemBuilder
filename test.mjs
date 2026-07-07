// Self-tests for schem-builder. Run with: node test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Schem,
  block,
  blocks,
  withState,
  stairs,
  hash3,
  buildExample,
  loadSchem,
  parseNbt,
  blockError,
  blockColor,
  nearestBlock,
  gradient,
  registryInfo,
} from "./schem-builder.mjs";
import { gableRoof, stairRun, tree, Heightmap } from "./prefabs.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schem-test-"));
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

test("block name helpers", () => {
  assert.equal(block("stone"), "minecraft:stone");
  assert.equal(block("minecraft:stone"), "minecraft:stone");
  assert.throws(() => block(""));
  assert.equal(withState("oak_stairs", { facing: "north" }), "minecraft:oak_stairs[facing=north]");
  assert.equal(
    withState(blocks.lantern, { hanging: true }),
    "minecraft:lantern[hanging=true,waterlogged=false]",
  );
  assert.equal(
    stairs("stone_brick", "east", "top"),
    "minecraft:stone_brick_stairs[facing=east,half=top,shape=straight,waterlogged=false]",
  );
  assert.equal(
    stairs("minecraft:oak_stairs"),
    "minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]",
  );
});

test("dimension validation", () => {
  assert.throws(() => new Schem(0, 1, 1), /positive/);
  assert.throws(() => new Schem(1.5, 1, 1), /integers/);
  assert.throws(() => new Schem(40000, 1, 1), /32767/);
  new Schem(1, 1, 1); // ok
});

test("hash3 determinism and seeding", () => {
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3));
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3, 0)); // seed 0 matches the unseeded value
  assert.notEqual(hash3(1, 2, 3), hash3(1, 2, 3, 1));
  const v = hash3(9, 9, 9);
  assert.ok(v >= 0 && v < 1);
});

test("fill accepts palettes; fillPalette is an alias", () => {
  const a = new Schem(4, 4, 4);
  const b = new Schem(4, 4, 4);
  a.fill(0, 0, 0, 3, 3, 3, [blocks.stone, blocks.andesite]);
  b.fillPalette(0, 0, 0, 3, 3, 3, [blocks.stone, blocks.andesite]);
  assert.deepEqual(a.blocks, b.blocks);
  const kinds = new Set(a.blocks);
  assert.ok(kinds.has("minecraft:stone") && kinds.has("minecraft:andesite"));
});

test("fill clamps out-of-bounds regions", () => {
  const s = new Schem(4, 4, 4);
  s.fill(-10, -10, -10, 20, 20, 20, blocks.stone);
  assert.equal(s.stats().nonAir, 64);
});

test("schematic seed changes palette noise", () => {
  const a = new Schem(8, 1, 8, { seed: 1 });
  const b = new Schem(8, 1, 8, { seed: 2 });
  a.fill(0, 0, 0, 7, 0, 7, [blocks.stone, blocks.andesite, blocks.cobblestone]);
  b.fill(0, 0, 0, 7, 0, 7, [blocks.stone, blocks.andesite, blocks.cobblestone]);
  assert.notDeepEqual(a.blocks, b.blocks);
});

test("sphere delegates to ellipsoid and takes palettes", () => {
  const s = new Schem(9, 9, 9);
  s.sphere(4, 4, 4, 3, [blocks.stone, blocks.andesite]);
  assert.notEqual(s.get(4, 4, 4), "minecraft:air");
  assert.equal(s.get(0, 0, 0), "minecraft:air");
});

test("dome only places blocks at or above its base", () => {
  const s = new Schem(16, 16, 16);
  s.dome(8, 5, 8, 5, 5, 5, blocks.stone);
  const st = s.stats();
  assert.ok(st.nonAir > 0);
  assert.ok(st.bounds.min[1] >= 5);
});

test("discY places a single layer", () => {
  const s = new Schem(16, 16, 16);
  s.discY(8, 8, 3, 4, blocks.stone);
  const st = s.stats();
  assert.equal(st.bounds.min[1], 3);
  assert.equal(st.bounds.max[1], 3);
});

test("ellipsoid yaw rotates the long axis from x to z", () => {
  const flat = new Schem(16, 16, 16);
  flat.ellipsoid(8, 8, 8, 6, 2, 2, blocks.stone);
  assert.notEqual(flat.get(13, 8, 8), "minecraft:air"); // long along x
  assert.equal(flat.get(8, 8, 13), "minecraft:air"); // short along z

  const turned = new Schem(16, 16, 16);
  turned.ellipsoid(8, 8, 8, 6, 2, 2, blocks.stone, { yaw: 90 });
  assert.equal(turned.get(13, 8, 8), "minecraft:air"); // now short along x
  assert.notEqual(turned.get(8, 8, 13), "minecraft:air"); // long along z
});

test("ellipsoid pitch tips the top toward +z; roll toward +x", () => {
  const pitched = new Schem(16, 16, 16);
  pitched.ellipsoid(8, 8, 8, 2, 6, 2, blocks.stone, { pitch: 90 });
  assert.equal(pitched.get(8, 13, 8), "minecraft:air"); // no longer tall
  assert.notEqual(pitched.get(8, 8, 13), "minecraft:air"); // long along z

  const rolled = new Schem(16, 16, 16);
  rolled.ellipsoid(8, 8, 8, 2, 6, 2, blocks.stone, { roll: 90 });
  assert.equal(rolled.get(8, 13, 8), "minecraft:air");
  assert.notEqual(rolled.get(13, 8, 8), "minecraft:air"); // long along x
});

test("rotated ellipsoid matches the unrotated shape's volume", () => {
  const a = new Schem(20, 20, 20);
  a.ellipsoid(10, 10, 10, 7, 3, 3, blocks.stone);
  const b = new Schem(20, 20, 20);
  b.ellipsoid(10, 10, 10, 7, 3, 3, blocks.stone, { yaw: 90 });
  const na = a.stats().nonAir;
  const nb = b.stats().nonAir;
  assert.ok(Math.abs(na - nb) / na < 0.1, `volumes differ too much: ${na} vs ${nb}`);
});

test("torus rings around y with an open center", () => {
  const s = new Schem(24, 8, 24);
  s.torus(12, 4, 12, 8, 2, blocks.gold);
  assert.notEqual(s.get(20, 4, 12), "minecraft:air"); // on the ring (+x)
  assert.notEqual(s.get(12, 4, 20), "minecraft:air"); // on the ring (+z)
  assert.equal(s.get(12, 4, 12), "minecraft:air"); // center hole
  assert.equal(s.get(12, 7, 12), "minecraft:air"); // above the hole
  const st = s.stats();
  assert.ok(st.bounds.max[1] - st.bounds.min[1] <= 4); // tube is 2r thick
});

test("torus stands upright with axis x or z; bad axis throws", () => {
  const s = new Schem(24, 24, 8);
  s.torus(12, 12, 4, 8, 2, blocks.gold, { axis: "z" }); // ring in the xy plane
  assert.notEqual(s.get(20, 12, 4), "minecraft:air"); // side of the ring
  assert.notEqual(s.get(12, 20, 4), "minecraft:air"); // top of the ring
  assert.equal(s.get(12, 12, 4), "minecraft:air"); // center hole
  assert.throws(() => s.torus(0, 0, 0, 4, 1, blocks.stone, { axis: "w" }), /Unknown torus axis/);
});

test("arch spans between its feet and stays open underneath", () => {
  const s = new Schem(16, 16, 16);
  s.arch(3, 1, 8, 11, 1, 8, blocks.stone);
  assert.notEqual(s.get(3, 1, 8), "minecraft:air"); // foot
  assert.notEqual(s.get(11, 1, 8), "minecraft:air"); // foot
  assert.notEqual(s.get(7, 5, 8), "minecraft:air"); // apex: halfSpan 4 -> rise 4
  assert.equal(s.get(7, 1, 8), "minecraft:air"); // under the arch
});

test("line accepts palettes", () => {
  const s = new Schem(8, 8, 8);
  s.line(0, 0, 0, 7, 7, 7, [blocks.stone, blocks.andesite]);
  assert.notEqual(s.get(0, 0, 0), "minecraft:air");
  assert.notEqual(s.get(7, 7, 7), "minecraft:air");
});

test("paste stamps a module with offset and skipAir semantics", () => {
  const stamp = new Schem(2, 2, 2);
  stamp.fill(0, 0, 0, 1, 1, 1, blocks.gold);
  const world = new Schem(8, 8, 8);
  world.fill(0, 0, 0, 7, 0, 7, blocks.stone);
  world.paste(stamp, 3, 1, 3);
  assert.equal(world.get(3, 1, 3), "minecraft:gold_block");
  assert.equal(world.get(4, 2, 4), "minecraft:gold_block");
  assert.equal(world.get(2, 1, 3), "minecraft:air");

  const world2 = new Schem(4, 4, 4);
  world2.fill(0, 0, 0, 3, 3, 3, blocks.stone);
  const holey = new Schem(2, 2, 2); // all air except one block
  holey.set(0, 0, 0, blocks.gold);
  world2.paste(holey, 1, 1, 1);
  assert.equal(world2.get(1, 1, 1), "minecraft:gold_block");
  assert.equal(world2.get(2, 2, 2), "minecraft:stone"); // air skipped
  world2.paste(holey, 1, 1, 1, { skipAir: false });
  assert.equal(world2.get(2, 2, 2), "minecraft:air"); // air pasted when asked
});

test("paste rotates geometry and block states", () => {
  const m = new Schem(3, 1, 2);
  m.set(2, 0, 0, blocks.gold);
  m.set(0, 0, 0, stairs("oak", "north"));
  m.set(1, 0, 0, withState(blocks.oakLog, { axis: "x" }));
  const w = new Schem(10, 5, 10);
  w.paste(m, 1, 0, 1, { rotate: 1 }); // 90 degrees clockwise seen from above
  // footprint becomes 2 wide x 3 long; (x, z) -> (l - 1 - z, x)
  assert.equal(w.get(1 + 1, 0, 1 + 2), "minecraft:gold_block"); // (2,0) -> (1,2)
  assert.equal(
    w.get(1 + 1, 0, 1 + 0),
    "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
  ); // north -> east
  assert.equal(w.get(1 + 1, 0, 1 + 1), "minecraft:oak_log[axis=z]"); // axis x -> z
});

test("paste mirrors geometry and swaps stair handedness", () => {
  const m = new Schem(2, 1, 1);
  m.set(0, 0, 0, "minecraft:oak_stairs[facing=east,half=bottom,shape=inner_left,waterlogged=false]");
  const w = new Schem(5, 2, 5);
  w.paste(m, 0, 0, 0, { mirrorX: true });
  assert.equal(
    w.get(1, 0, 0),
    "minecraft:oak_stairs[facing=west,half=bottom,shape=inner_right,waterlogged=false]",
  );
});

test("stampLayers places ASCII floor plans", () => {
  const s = new Schem(6, 4, 6);
  s.stampLayers(1, 1, 1, { "#": blocks.stone, g: blocks.glass }, [
    ["###", "#.#", "###"],
    ["g.g"],
  ]);
  assert.equal(s.get(1, 1, 1), "minecraft:stone"); // first row, first column
  assert.equal(s.get(2, 1, 2), "minecraft:air"); // "." skipped
  assert.equal(s.get(3, 1, 3), "minecraft:stone");
  assert.equal(s.get(1, 2, 1), "minecraft:glass"); // second layer, one up
  assert.equal(s.get(2, 2, 1), "minecraft:air");
  assert.throws(() => s.stampLayers(0, 0, 0, {}, [["?"]]), /not in the legend/);
});

test("stampLayers can carve air and counts out-of-bounds cells", () => {
  const s = new Schem(3, 2, 3);
  s.fill(0, 0, 0, 2, 1, 2, blocks.stone);
  s.stampLayers(0, 0, 0, { _: "air" }, [["_"]]);
  assert.equal(s.get(0, 0, 0), "minecraft:air");
  const before = s.droppedWrites;
  s.stampLayers(2, 0, 2, { "#": blocks.stone }, [["##"]]); // second column off the edge
  assert.equal(s.droppedWrites, before + 1);
});

test("strict mode throws on out-of-bounds writes", () => {
  const s = new Schem(2, 2, 2, { strict: true });
  assert.throws(() => s.set(5, 0, 0, blocks.stone), /out of bounds/i);
  const loose = new Schem(2, 2, 2);
  loose.set(5, 0, 0, blocks.stone);
  assert.equal(loose.droppedWrites, 1);
  assert.equal(loose.stats().droppedWrites, 1);
});

test("sliceText renders trimmed grids with a legend", () => {
  const s = new Schem(8, 4, 8);
  s.fill(2, 1, 2, 5, 1, 4, blocks.stone);
  s.set(3, 1, 3, blocks.gold);
  const text = s.sliceText("y", 1);
  assert.match(text, /y=1 slice/);
  assert.match(text, /rows z=2\.\.4/);
  assert.match(text, /columns x=2\.\.5/);
  const lines = text.split("\n");
  assert.equal(lines[1], "####"); // z=2 row, all stone
  assert.equal(lines[2], "#o##"); // gold marker at x=3
  assert.match(text, /# = minecraft:stone \(11\)/);
  assert.match(text, /o = minecraft:gold_block \(1\)/);
  assert.equal(s.sliceText("y", 3), "y=3 slice: all air");
});

test("sliceText vertical slices run top-to-bottom", () => {
  const s = new Schem(4, 4, 4);
  s.set(1, 0, 2, blocks.stone);
  s.set(2, 0, 2, blocks.stone);
  s.set(1, 2, 2, blocks.gold);
  const text = s.sliceText("z", 2);
  const lines = text.split("\n");
  assert.match(lines[0], /rows y=2\.\.0/);
  assert.equal(lines[1], "o."); // gold up high, first grid row
  assert.equal(lines[2], "..");
  assert.equal(lines[3], "##"); // stone floor, last grid row
});

test("at() gives a local frame; frames nest", () => {
  const s = new Schem(10, 10, 10);
  const f = s.at(2, 3, 4);
  f.set(0, 0, 0, blocks.gold);
  f.fill(1, 0, 1, 2, 0, 2, blocks.stone);
  assert.equal(s.get(2, 3, 4), "minecraft:gold_block");
  assert.equal(s.get(4, 3, 6), "minecraft:stone");
  assert.equal(f.get(0, 0, 0), "minecraft:gold_block");
  const g = f.at(1, 1, 1);
  g.set(0, 0, 0, blocks.iron);
  assert.equal(s.get(3, 4, 5), "minecraft:iron_block");
});

test("stats reports bounds and excludes air from topBlocks", () => {
  const s = new Schem(8, 8, 8);
  s.fill(2, 3, 4, 5, 3, 6, blocks.stone);
  const st = s.stats();
  assert.deepEqual(st.bounds, { min: [2, 3, 4], max: [5, 3, 6] });
  assert.equal(st.nonAir, 4 * 1 * 3);
  assert.ok(st.topBlocks.every(([name]) => name !== "minecraft:air"));
  assert.equal(new Schem(2, 2, 2).stats().bounds, null); // empty schem has no bounds
});

test("gableRoof builds stair slopes with a slab ridge on odd spans", () => {
  const s = new Schem(8, 8, 8);
  gableRoof(s, 1, 1, 6, 5, 2, { material: "oak" }); // z span 1..5 -> ridge at z=3
  assert.equal(s.get(3, 2, 1), stairs("oak", "south"));
  assert.equal(s.get(3, 2, 5), stairs("oak", "north"));
  assert.equal(s.get(3, 3, 2), stairs("oak", "south"));
  assert.equal(s.get(3, 4, 3), "minecraft:oak_slab[type=bottom]");
});

test("stairRun ascends with correctly-faced stairs and support", () => {
  const s = new Schem(8, 8, 8);
  stairRun(s, 1, 1, 1, "east", 3, "oak", { support: "solid", supportMaterial: blocks.stone });
  assert.equal(s.get(1, 1, 1), stairs("oak", "east"));
  assert.equal(s.get(2, 2, 1), stairs("oak", "east"));
  assert.equal(s.get(3, 3, 1), stairs("oak", "east"));
  assert.equal(s.get(3, 2, 1), "minecraft:stone"); // support column under step 3
  assert.equal(s.get(3, 1, 1), "minecraft:stone");
});

test("tree prefab plants a trunk and leaves", () => {
  const s = new Schem(16, 20, 16);
  tree(s, 8, 1, 8, { style: "oak", height: 5, radius: 2.5 });
  assert.equal(s.get(8, 1, 8), "minecraft:oak_log");
  assert.ok(s.stats().topBlocks.some(([name]) => name.includes("leaves")));
  tree(s, 3, 1, 3, { style: "spruce", height: 8 });
  assert.equal(s.get(3, 1, 3), "minecraft:spruce_log");
  assert.throws(() => tree(s, 0, 0, 0, { style: "palm" }), /Unknown tree style/);
});

test("Heightmap builds deterministic terrain and paints columns", () => {
  const a = Heightmap.fromNoise(12, 12, { base: 8, amplitude: 2, seed: 5 });
  const b = Heightmap.fromNoise(12, 12, { base: 8, amplitude: 2, seed: 5 });
  assert.deepEqual([...a.data], [...b.data]);
  const c = Heightmap.fromNoise(12, 12, { base: 8, amplitude: 2, seed: 6 });
  assert.notDeepEqual([...a.data], [...c.data]);

  const s = new Schem(12, 16, 12);
  a.paintTo(s, { top: blocks.grass, under: blocks.dirt, depth: 2, base: blocks.stone });
  const y = a.surfaceY(5, 5);
  assert.equal(s.get(5, y, 5), "minecraft:grass_block");
  assert.equal(s.get(5, y - 1, 5), "minecraft:dirt");
  assert.equal(s.get(5, 0, 5), "minecraft:stone");
  assert.equal(s.get(5, y + 1, 5), "minecraft:air");
});

test("NBT structure of a minimal schematic", () => {
  const s = new Schem(1, 1, 1, { name: "tiny", dataVersion: 3465, offset: [1, 2, 3] });
  s.set(0, 0, 0, blocks.stone);
  const nbt = parseNbt(s.toNbtBuffer());
  assert.equal(nbt.name, "Schematic");
  assert.equal(nbt.value.Version, 2);
  assert.equal(nbt.value.DataVersion, 3465);
  assert.equal(nbt.value.Width, 1);
  assert.equal(nbt.value.Height, 1);
  assert.equal(nbt.value.Length, 1);
  assert.deepEqual([...nbt.value.Offset], [1, 2, 3]);
  assert.deepEqual(nbt.value.Palette, { "minecraft:stone": 0 });
  assert.equal(nbt.value.PaletteMax, 1);
  assert.deepEqual([...nbt.value.BlockData], [0]);
  assert.equal(nbt.value.Metadata.Name, "tiny");
});

test("save/loadSchem round-trips the example build", () => {
  const original = buildExample();
  const file = path.join(tmp, "example.schem");
  original.save(file);
  const loaded = loadSchem(file);
  assert.equal(loaded.width, original.width);
  assert.equal(loaded.height, original.height);
  assert.equal(loaded.length, original.length);
  assert.equal(loaded.name, original.name);
  assert.equal(loaded.dataVersion, original.dataVersion);
  assert.deepEqual([...loaded.offset], [...original.offset]);
  assert.deepEqual(loaded.blocks, original.blocks);
});

test("multi-byte VarInt palettes round-trip", () => {
  const s = new Schem(16, 2, 16, { validate: false }); // fake block names on purpose
  let i = 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      s.set(x, 0, z, `minecraft:fake_block_${i++}`);
    }
  }
  // 256 distinct names + air -> palette ids past 127 need two-byte VarInts
  const file = path.join(tmp, "varint.schem");
  s.save(file);
  const loaded = loadSchem(file);
  assert.deepEqual(loaded.blocks, s.blocks);
});

test("registry validates block names and states on write", () => {
  assert.ok(registryInfo().blocks > 1000, "registry should know 1000+ blocks");

  const s = new Schem(4, 4, 4);
  assert.throws(() => s.set(0, 0, 0, "minecraft:stonebrick"), /did you mean "stone_bricks?"/);
  assert.throws(() => s.fill(0, 0, 0, 1, 1, 1, "oak_stairs[facing=up]"), /Invalid value "up"/);
  assert.throws(() => s.set(0, 0, 0, "stone[waterlogged=true]"), /has no state "waterlogged"/);
  s.set(0, 0, 0, "sculk"); // any real block works, not just aliases
  s.set(1, 0, 0, "mymod:custom_block"); // other namespaces are not validated

  const loose = new Schem(4, 4, 4, { validate: false });
  loose.set(0, 0, 0, "minecraft:not_a_block"); // opt-out for fakes/other versions
  assert.equal(loose.get(0, 0, 0), "minecraft:not_a_block");
});

test("blockError reports problems without a schematic", () => {
  assert.equal(blockError("minecraft:stone"), null);
  assert.equal(blockError("minecraft:oak_leaves[distance=3,persistent=true]"), null);
  assert.match(blockError("minecraft:oak_leaves[distance=9]"), /valid: 1, 2, 3, 4, 5, 6, 7/);
  assert.match(blockError("minecraft:grass_blok"), /did you mean "grass_block"/);
});

test("blockColor, nearestBlock, and gradient use real texture colors", () => {
  const gold = blockColor("gold_block");
  assert.ok(gold[0] > 200 && gold[1] > 150 && gold[2] < 120, `gold_block should be yellow, got ${gold}`);
  assert.deepEqual(blockColor("oak_stairs[facing=east]"), blockColor("oak_stairs")); // states ignored
  assert.equal(blockColor("mymod:thing"), null);

  const red = nearestBlock("#8e2020"); // red_concrete's exact color
  assert.equal(red, "minecraft:red_concrete");
  const notConcrete = nearestBlock("#8e2020", { exclude: ["red_concrete"] });
  assert.notEqual(notConcrete, "minecraft:red_concrete");
  const top3 = nearestBlock([255, 255, 255], { count: 3 });
  assert.equal(top3.length, 3);

  const ramp = gradient("black_concrete", "white_concrete", 5);
  assert.equal(ramp.length, 5);
  assert.equal(ramp[0], "minecraft:black_concrete");
  assert.equal(ramp[4], "minecraft:white_concrete");
  // every gradient step must be a placeable block
  const s = new Schem(5, 1, 1);
  ramp.forEach((name, i) => s.set(i, 0, 0, name));
});

test("nearestBlock defaults to full opaque cubes", () => {
  // ask for pure white: snow/quartz-ish cubes should win, never glass or air
  const names = nearestBlock([255, 255, 255], { count: 10 });
  for (const n of names) {
    assert.ok(!n.includes("glass") && !n.includes("air"), `${n} is not a solid cube`);
  }
});

test("render-preview has real colors for the artistic palette", () => {
  const dyes = [
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
    "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
  ];
  const names = [];
  for (const d of dyes) {
    names.push(
      `${d}_wool`, `${d}_terracotta`, `${d}_glazed_terracotta`,
      `${d}_concrete`, `${d}_concrete_powder`, `${d}_stained_glass`,
    );
  }
  names.push(
    // derived variants: waxed copper, panes, carpet, stairs/slabs/walls/fences
    "copper_block", "exposed_copper", "weathered_copper", "oxidized_copper",
    "waxed_oxidized_copper", "waxed_cut_copper_stairs", "cut_copper_slab",
    "purple_stained_glass_pane", "red_carpet", "stone_brick_wall",
    "oak_fence", "spruce_fence_gate", "quartz_stairs", "purpur_slab",
    "obsidian", "end_stone", "amethyst_block", "bone_block",
    // registry-only blocks (no hand-tuned entry, colors from block-data.json)
    "sculk", "ochre_froglight", "verdant_froglight", "pearlescent_froglight",
    "cherry_leaves", "pale_oak_planks", "mushroom_stem", "crying_obsidian",
    "warped_wart_block", "dripstone_block", "rooted_dirt", "sea_pickle",
  );
  const scene = path.join(tmp, "palette-scene.mjs");
  fs.writeFileSync(scene, `
    const names = ${JSON.stringify(names)};
    export default function ({ Schem }) {
      const side = Math.ceil(Math.sqrt(names.length));
      const s = new Schem(side, 1, side);
      names.forEach((n, i) => s.set(i % side, 0, Math.floor(i / side), "minecraft:" + n));
      return s;
    }
  `);
  const out = spawnSync(
    process.execPath,
    ["render-preview.mjs", scene, path.join(tmp, "palette"), "--views", "top"],
    { cwd: import.meta.dirname, encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes("no color entry for"), `fallback colors used:\n${out.stdout}`);
  assert.ok(fs.existsSync(path.join(tmp, "palette-top.png")));
});
