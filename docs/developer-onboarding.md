# MarbleRush Developer Onboarding

This document is a short map for new developers joining the `volang`, `voplay`, and `MarbleRush` codebases.

## Repository Roles

`volang` is the language and toolchain repository. It contains the Vo compiler/runtime, the Studio UI, and the local project runner used during development.

`voplay` is the game engine layer written for Vo projects. It provides the game loop, input, draw command stream, resource loading, `scene3d`, `primitive3d`, and the Rust/WebGPU renderer.

`MarbleRush` is the game project. It depends on `voplay` and is currently moving toward a low-poly, Nintendo-like kart racing look built from a small fixed set of primitive meshes and materials.

## Local Paths

```text
/Users/wuhao/code/github/volang
/Users/wuhao/code/github/voplay
/Users/wuhao/code/github/MarbleRush
```

## Running The Studio

Start the local Studio from the `volang` repo:

```bash
cd /Users/wuhao/code/github/volang
./d.py studio
```

Open MarbleRush in the runner:

```text
http://localhost:5174/?proj=/Users/wuhao/code/github/MarbleRush&mode=runner&debug=1#/runner
```

The project path is passed through the `proj` query parameter. A project does not need to be a sibling of `MarbleRush`; it can live anywhere as long as the absolute path is supplied.

## Common Checks

Check MarbleRush:

```bash
cd /Users/wuhao/code/github/volang
./d.py check /Users/wuhao/code/github/MarbleRush
```

Check a voplay primitive rendering example:

```bash
cd /Users/wuhao/code/github/volang
./d.py check /Users/wuhao/code/github/voplay/examples/primitive_stress
```

If you change the Rust renderer:

```bash
cd /Users/wuhao/code/github/voplay/rust
cargo test
```

## voplay Architecture Notes

`voplay` uses a split-island architecture:

- The logic island runs Vo game code.
- The render island owns the GPU surface and frame clock.
- The render island sends input snapshots to the logic island.
- The logic island advances simulation and returns draw command bytes.
- The render island submits those bytes to the Rust/WebGPU renderer.

Normal games should be paced by the display pulse / `requestAnimationFrame`. Timer-driven frame pacing is avoided because browser timers can introduce long-tail stalls. `UncappedFrameRate` is reserved for measurement and stress testing.

Primitive rendering is intended to be an engine-level module, not a MarbleRush-specific patch. The goal is to render many objects from a fixed set of primitive shapes and a small material palette through retained layers, batching, chunking, and GPU instancing.

## MarbleRush Key Files

```text
main.vo              Entry point and voplay.Game configuration.
world.vo             Main world state, scene drawing, HUD data.
primitive_world.vo   Primitive scene construction: track visuals, terrain props, trees, rocks, clouds.
theme.vo             Visual theme, material colors, HUD and debug panel drawing.
play_state.vo        High-level game state wrapper.
gameplay.vo          Gameplay constants and behavior.
```

## Performance Debugging

Run with `debug=1` and press `F3` in the runner.

The F3 panel currently exposes:

- FPS, frame time, logic time, and frame budget.
- Input / advance / draw / overlay phase timing.
- Draw bytes and submitted bytes.
- Fixed-step count.
- Slow-frame count and the latest slow frame.
- Scene, primitive, and vehicle statistics.

Console logs include:

```text
voplay slow frame ...
voplay render slow frame ...
```

Interpretation:

- `voplay render slow frame reason=loop`: the render island frame loop was delayed, usually by browser scheduling or frame pacing.
- `voplay render slow frame reason=submit`: GPU/renderer submission took too long.
- `voplay slow frame reason=logic`: game-side logic was slow.
- High `advanceMs`: simulation/update work is expensive.
- High `drawMs`: command generation or scene traversal is expensive.
- High fixed-step count: the engine is catching up after a delayed frame.

## Visual Direction

MarbleRush is aiming for a readable low-poly toy-like style:

- Clear silhouettes before small details.
- Strong primary color palettes rather than scattered accent colors.
- Matte or lightly glossy materials, not overly mirrored surfaces.
- Terrain should have shape, normals, and color variation instead of flat blurry color.
- Roads can use custom meshes instead of primitive blocks, but materials should remain consistent with the primitive world.

When improving visuals, prefer changes that strengthen readability and material identity before adding more objects.
