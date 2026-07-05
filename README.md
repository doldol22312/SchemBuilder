# schembuilder

Dependency-free Node.js helpers for generating and previewing WorldEdit/Sponge `.schem` files.

This is meant for agents that can write JavaScript but should not have to remember
the binary `.schem` details. The toolkit handles:

- Sponge schematic NBT structure (writes v2, reads v2 and v3)
- palette IDs and VarInt `BlockData`
- gzip compression
- common geometry helpers
- orthographic PNG previews, so you can iterate visually without launching Minecraft

## Files

- `schem-builder.mjs` — the library and CLI (build, run scene modules, stats, slices)
- `prefabs.mjs` — higher-level parts: gable roofs, stair runs, trees, terrain heightmaps
- `render-preview.mjs` — renders PNG previews of a scene module or `.schem` file
- `example-scene.mjs` — a small demo scene that uses most of the API
- `test.mjs` — self-tests (`npm test`)

## Quick Start

```powershell
cd D:\schembuilder

node .\schem-builder.mjs example .\out\quick-example.schem
node .\schem-builder.mjs run .\example-scene.mjs .\out\example-scene.schem
node .\render-preview.mjs .\example-scene.mjs .\out\example-scene
```

Load the resulting file with WorldEdit:

```text
//schem load quick-example
//paste
```

Copy the `.schem` into your WorldEdit schematics folder if your server/client does
not load directly from this output folder.

## Agent Pattern

Write a scene file that exports a function. Return a `Schem` instance.

```js
export default function ({ Schem, blocks, block, withState, stairs, prefabs, pick, hash3 }) {
  const s = new Schem(64, 48, 64, {
    name: "agent scene",
    offset: [-32, 0, -32],
    seed: 7, // optional: changes all palette/noise patterns deterministically
  });

  s.fill(0, 0, 0, 63, 0, 63, blocks.grass);
  s.hollowBox(20, 1, 20, 44, 12, 44, [blocks.oakPlanks, blocks.sprucePlanks]);
  s.fill(28, 2, 20, 36, 6, 20, blocks.air);
  s.ellipsoid(32, 24, 32, 14, 9, 14, [blocks.oakLeaves, blocks.azaleaLeaves], { noise: 0.2 });

  return s;
}
```

Run it, then preview it:

```powershell
node .\schem-builder.mjs run .\my-scene.mjs .\out\my-scene.schem
node .\render-preview.mjs .\my-scene.mjs .\out\my-scene
node .\schem-builder.mjs slice .\my-scene.mjs y=2
```

The typical loop is: edit the scene, check logic with text slices, check looks
with the PNG previews, repeat — and only paste into Minecraft at the end.

## Previews

`render-preview.mjs` renders orthographic PNGs of a scene module **or** an
existing `.schem` file (v2 or v3):

```powershell
node .\render-preview.mjs .\my-scene.mjs .\out\my-scene
node .\render-preview.mjs .\out\my-scene.schem .\out\my-scene
node .\render-preview.mjs .\my-scene.mjs .\out\plan --views top,front --cut y=6
```

Options:

- `--views a,b,c` — subset of `front`, `back`, `left`, `right`, `top` (default: all five)
- `--scale N` — pixels per block (default: auto-fit toward ~512 px, between 1 and 6)
- `--cut y=N` — cutaway: hides every block with `y > N` (also `x=N` / `z=N`).
  Cut the roof off and render `top` to inspect interiors and floor plans.

Orientation (also printed with each file):

- `front` — from the south (+Z) looking north; east (+X) is right
- `back` — from the north (-Z) looking south; west (-X) is right
- `right` — from the east (+X) looking west; north (-Z) is right
- `left` — from the west (-X) looking east; south (+Z) is right
- `top` — from above looking down; east (+X) is right, south (+Z) is down

Glass and water render translucent. Every alias in `blocks` has a real color;
unknown blocks get a deterministic fallback color and are listed at the end of
the run so you can add proper entries to `COLORS`.

## Builder API

`new Schem(width, height, length, options)`

Creates an empty schematic. Options: `name`, `offset`, `dataVersion`, `seed`, `strict`.
Dimensions must be integers in 1..32767 (the `.schem` format stores them as shorts);
violations throw immediately rather than at save time. With `strict: true`, any
write that lands outside the schematic throws; otherwise such writes are counted
in `stats().droppedWrites`.

`s.set(x, y, z, blockName)` / `s.get(x, y, z)`

Places/reads one block. Coordinates are rounded. Out-of-bounds writes are ignored;
out-of-bounds reads return air.

`s.setIfAir(x, y, z, blockName)`

Places a block only if the cell is currently air.

`s.paint(x, y, z, palette)`

Like `set`, but accepts a palette and picks deterministically.

`s.fill(x1, y1, z1, x2, y2, z2, palette)`

Fills a rectangular volume. Accepts a single block or a palette array
(`fillPalette` still exists as an alias).

`s.hollowBox(x1, y1, z1, x2, y2, z2, palette, thickness)`

Builds only the shell of a rectangular volume.

`s.line(x1, y1, z1, x2, y2, z2, palette, radius)`

Draws a 3D line. Radius `0` is a one-block line; radius `1` makes beams/ropes.

`s.arch(x1, y1, z1, x2, y2, z2, palette, options)`

Semicircular arch between two feet. `options.rise` sets apex height above the
midpoint (default: half the span); `options.radius` is beam thickness like `line`.

`s.sphere(cx, cy, cz, radius, palette, options)`

Solid sphere; takes the same options as `ellipsoid`.

`s.ellipsoid(cx, cy, cz, rx, ry, rz, palette, options)`

Ellipsoid. Useful options: `{ solid: true, noise: 0.2 }`, `{ solid: false, shellMin: 0.78 }`,
and `minY` / `maxY` to clip the shape vertically.

`s.dome(cx, cy, cz, rx, ry, rz, palette, options)`

Upper half of an ellipsoid shell — a roof. The base is always at `cy`.
Pass `{ solid: true }` for a filled dome.

`s.cylinderY(cx, cz, y1, y2, radius, palette, options)`

Vertical cylinder. `{ noise: 0.4 }` roughens the wall.

`s.discY(cx, cz, y, radius, palette, options)`

Single-layer horizontal disc (ponds, plazas, tower floors).

`s.frustumY(cx, cz, y1, y2, radius1, radius2, palette, options)`

Tapered vertical cylinder. Use `{ shell: true, thickness: 2 }` for towers.

`s.paste(other, dx, dy, dz, options)`

Stamps another `Schem` into this one at the given offset. Build a module (tree,
house, pillar) once and stamp it repeatedly. Air cells are skipped unless
`{ skipAir: false }`. `{ rotate: 0..3 }` turns the module in quarter-turns
clockwise (viewed from above) and `{ mirrorX: true }` / `{ mirrorZ: true }` flip
it — directional block states (`facing`, `axis`, stair `shape`) rotate and
mirror along with the geometry. Mirrors apply before rotation.

`s.stampLayers(x, y, z, legend, layers)`

Stamps ASCII floor plans — see "ASCII floor plans" below.

`s.at(x, y, z)`

Returns a local frame — see "Local frames" below.

`s.sliceText(axis, index, options)`

Returns an ASCII slice of the build — see "Text slices" below.

`s.stats()`

Returns dimensions, `nonAir` count, the used `bounds` (min/max of non-air blocks —
handy for checking you filled the volume you intended), `droppedWrites` (writes
that fell outside the schematic), palette size, and the top non-air blocks.

`s.save(filePath)`

Writes a gzipped `.schem` file.

`loadSchem(filePath)`

Reads an existing `.schem` (Sponge v2 or v3, from WorldEdit or this tool) into a
`Schem` you can inspect, edit, `paste` into another schematic, or re-save.
Block entities/entities are not carried over.

## Blocks

Use aliases from `blocks`, pass a Minecraft block string, or compose states:

```js
s.set(10, 5, 10, blocks.glowstone);
s.set(11, 5, 10, stairs("oak", "north"));                    // oriented stairs
s.set(12, 5, 10, withState(blocks.lantern, { hanging: true })); // merge states
s.set(13, 5, 10, "minecraft:lantern[hanging=false,waterlogged=false]");
```

- `block("stone")` becomes `"minecraft:stone"`.
- `withState(name, states)` composes or merges `[key=value]` block states.
- `stairs(material, facing, half, shape)` builds a fully-qualified stairs string;
  `facing` is the ascending direction.

## ASCII floor plans

Drawing a floor plan as text is far less error-prone than computing fill
coordinates. `stampLayers` places one character grid per Y level, bottom-up.
Rows run north→south (z), columns west→east (x) — exactly the orientation of
the `top` preview and `sliceText("y", ...)`, so what you draw is what you see.

```js
const wall = [
  "l#####l",
  "#.....#",
  "#.....#",
  "l##d##l",
];
s.stampLayers(8, 1, 8, {
  "#": [blocks.sprucePlanks, blocks.darkOakPlanks], // palettes work
  l: blocks.oakLog,
  d: null,   // doorway: leave whatever is there
  _: "air",  // mapping to "air" carves
}, [wall, wall, wall]);
```

`.` and space skip by default; any character not in the legend throws (typo
protection). Layers stack upward: `[base, base, top]` or `Array(4).fill(wall)`.

## Text slices

`sliceText(axis, index)` returns a character-grid slice with a legend — the
cheap way to verify logic without rendering an image:

```powershell
node .\schem-builder.mjs slice .\my-scene.mjs y=2 z=8      # add --full to skip trimming
```

```text
y=2 slice (matches the top view): rows z=8..22 north->south, columns x=8..24 west->east
#################
#...............#
...

# = minecraft:stone_bricks (52)
```

Orientation matches the previews: `y=N` is the top view (floor plan), `z=N` is
the front view, `x=N` is the left view. Grids are trimmed to the non-air
bounding box; the header states the coordinate ranges.

## Local frames

`s.at(x, y, z)` returns a frame: the full drawing API with coordinates local to
that origin, so structure code uses small relative numbers instead of absolute
world coordinates. Frames nest.

```js
const room = s.at(8, 1, 8);
room.fill(1, 0, 1, 15, 0, 13, blocks.sprucePlanks); // world (9,1,9)..(23,1,21)
room.set(8, 5, 7, blocks.glowstone);
const closet = room.at(12, 0, 10);
```

## Prefabs

`prefabs.mjs` assembles common parts from the primitives (scene modules receive
it as `prefabs`; every function takes the target `Schem` or frame first):

`prefabs.gableRoof(s, x1, z1, x2, z2, y, options)` — A-frame roof of correctly
faced stairs, slab ridge on odd spans. Options: `material` (a stem like `"oak"`
or `"stone_brick"`), `axis` (`"x"`/`"z"`, default: the longer side), `ridge`,
`gable` (block/palette for the triangular end walls).

`prefabs.stairRun(s, x, y, z, direction, steps, material, options)` — straight
staircase ascending toward `direction`, one up per step. Options: `width`,
`support` (`"none"` | `"under"` | `"solid"`), `supportMaterial`.

`prefabs.tree(s, x, y, z, options)` — parameterized trees, `style: "oak"`
(round crown) or `"spruce"` (cone). Size varies deterministically per position;
override with `height`/`radius`, re-skin with `log`/`leaves`.

`prefabs.Heightmap` — rolling terrain:

```js
const ground = prefabs.Heightmap.fromNoise(64, 64, { base: 4, amplitude: 3, scale: 14, seed: 2 });
ground.paintTo(s, { top: blocks.grass, under: blocks.dirt, depth: 3, base: blocks.stone });
prefabs.tree(s, 20, ground.surfaceY(20, 30) + 1, 30, { style: "spruce" });
```

## Deterministic noise and seeds

All palette variation and `noise` options come from `hash3(x, y, z, seed)` — the
same scene always produces the same build. Set `seed` in the `Schem` options to
get a different (but equally stable) variation without touching the geometry.

## DataVersion

`dataVersion` tells Minecraft which version's block format the schematic uses.
The default `3465` (1.20.1) is safe: newer game versions upgrade older data
automatically, but not the other way around. Common values:

| Minecraft | DataVersion |
| --------- | ----------- |
| 1.20.1    | 3465 (default) |
| 1.20.4    | 3700 |
| 1.21      | 3953 |
| 1.21.4    | 4189 |

## CLI

```powershell
node .\schem-builder.mjs example <out.schem>     # build the built-in example
node .\schem-builder.mjs run <scene.mjs> <out.schem>
node .\schem-builder.mjs stats <file.schem>      # inspect any existing .schem
node .\schem-builder.mjs slice <scene.mjs|file.schem> y=6 [x=3 z=4 ...] [--full]
node .\render-preview.mjs <scene.mjs|file.schem> <outPrefix> [--views ...] [--scale N] [--cut y=N]
node .\test.mjs                                  # or: npm test
```

## Practical Notes

- Keep dimensions under 32,767 because `.schem` dimensions are stored as shorts
  (the constructor enforces this).
- Build coarse masses first, then carve air, then add trim/details.
- Use palettes for natural surfaces instead of one flat material.
- Store terrain heights in a map when you need paths, trees, or buildings that sit
  on the ground.
- Check `stats().bounds` after building — if it doesn't match the volume you meant
  to use, something is misplaced.
- Large schematics can paste slowly in Minecraft, so prefer detail density over
  huge empty volume.
