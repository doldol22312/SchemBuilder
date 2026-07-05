// Example scene for schem-builder. Demonstrates ASCII floor plans
// (stampLayers), local frames (at), prefabs (gableRoof, tree), rotated paste,
// palette fills, hollow shells, domes, arches, and block states.
//
// Build:   node schem-builder.mjs run example-scene.mjs out/example-scene.schem
// Preview: node render-preview.mjs example-scene.mjs out/example-scene
// Inspect: node schem-builder.mjs slice example-scene.mjs y=2

export default function ({ Schem, blocks, withState, stairs, prefabs }) {
  const s = new Schem(48, 32, 48, { name: "example scene", offset: [-24, 0, -24], seed: 7 });

  // ground: grassy with patches of coarse dirt
  s.fill(0, 0, 0, 47, 0, 47, [blocks.grass, blocks.grass, blocks.grass, blocks.coarseDirt]);

  // stone cottage: hollow shell with a dome roof
  s.hollowBox(8, 1, 8, 24, 8, 22, [blocks.stoneBricks, blocks.stoneBricks, blocks.mossyStoneBricks]);
  s.dome(16, 8, 15, 10, 6, 9, [blocks.deepslateTiles, blocks.blackstone]);

  // interior via a local frame: coordinates are relative to the room corner
  const room = s.at(8, 1, 8);
  room.fill(1, 0, 1, 15, 0, 13, blocks.sprucePlanks); // floor
  room.set(8, 5, 7, withState(blocks.lantern, { hanging: true }));

  // door and windows on the south wall, stairs as a doorstep
  s.fill(15, 2, 8, 16, 4, 8, blocks.air);
  s.fill(11, 3, 8, 12, 4, 8, blocks.glass);
  s.fill(20, 3, 8, 21, 4, 8, blocks.glass);
  s.set(15, 1, 7, stairs("stone_brick", "north"));
  s.set(16, 1, 7, stairs("stone_brick", "north"));

  // free-standing arch in the garden
  s.arch(30, 1, 10, 38, 1, 10, [blocks.stoneBricks, blocks.mossyStoneBricks], { radius: 1 });

  // a reusable shed module: walls drawn as ASCII floor plans, gable roof on top
  const shed = new Schem(7, 8, 6, { name: "shed", seed: 11 });
  const wall = [
    "l#####l",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "l#####l",
  ];
  const wallWithDoor = [
    "l#####l",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "l##d##l",
  ];
  shed.stampLayers(0, 0, 0, {
    "#": [blocks.sprucePlanks, blocks.sprucePlanks, blocks.darkOakPlanks],
    l: blocks.oakLog,
    d: null, // doorway: leave open
  }, [wallWithDoor, wallWithDoor, wall]);
  prefabs.gableRoof(shed, 0, 0, 6, 5, 3, { material: "spruce", gable: blocks.sprucePlanks });

  // stamp it twice; the rotated copy's door and roof stairs face west
  s.paste(shed, 29, 1, 30);
  s.paste(shed, 2, 1, 12, { rotate: 1 });

  // prefab trees, sized deterministically per position
  prefabs.tree(s, 10, 1, 40, { style: "oak" });
  prefabs.tree(s, 40, 1, 40, { style: "spruce" });
  prefabs.tree(s, 44, 1, 28, { style: "spruce" });

  // pond with a noisy shoreline
  s.discY(38, 16, 0, 4, blocks.water, { noise: 0.5 });

  return s;
}
