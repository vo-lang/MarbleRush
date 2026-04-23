# MarbleRush Step 0-1 Plan

This document narrows the next phase of MarbleRush to two goals only:

1. Step 0: upgrade the visual presentation from tech demo to a cheerful toy-like action game.
2. Step 1: define reusable scene building blocks that can assemble levels cleanly.

Level text format and authored levels are intentionally out of scope for this phase.

## Current State

Today MarbleRush is a solid movement prototype, but it still reads like an engine proof:

- the world is assembled directly inside `world.vo`
- geometry is hard-coded as one-off cubes
- the HUD is a debug panel
- color and lighting are serviceable but not game-like
- there is no reusable scene vocabulary yet

That means every future level change would currently become another custom edit in `world.vo`.

## Product Direction For This Phase

The target feeling is:

- bright and readable at a glance
- playful and toy-like rather than realistic
- chunky and intentional rather than programmer-gray
- optimistic and arcade-like
- easy to expand with more block types later

This should feel closer to a polished platform toybox than to a rendering sample.

## Step 0: Visual Style

### Style Pillars

The visual direction should follow five rules:

1. Large readable shapes first. The player should understand the path from camera distance.
2. Saturated hero colors with restrained neutrals under them.
3. Rounded, friendly composition even when built from primitive meshes.
4. Strong foreground/background separation using sky, fog, and lighting.
5. UI that feels like game UI, not engine diagnostics.

### Visual Language

The first pass should rely on simple primitive geometry and color blocking instead of detailed assets.

- Ground: warm, slightly bright, inviting base colors
- Walls and support pieces: deeper cool neutrals
- Interactive path pieces: stronger accents
- Goal area: highest contrast and strongest celebratory color
- Background decorations: lower saturation than gameplay-critical pieces

### Initial Palette

Use a small palette with clear roles:

- Sky: bright cyan / blue gradient feeling
- Grass or ground accent: green-teal family
- Main path solids: warm cream, yellow, coral, or orange-red accents
- Structural blockers: muted blue-gray
- Goal zone: gold + red or gold + teal
- Player marble: glossy bright color that stands apart from the level

The key point is role separation, not exact hex permanence. Final colors can shift after the first playable pass.

### Scene Presentation Upgrades

Step 0 should include:

- a proper sky and fog color relationship
- warmer ambient light
- one clear sun direction for readable shading
- stronger contrast between traversable pieces and side structures
- a minimal in-game HUD
- no always-on debug overlay

### HUD Direction

Replace the current debug text wall with a compact game HUD:

- level title or short subtitle
- reset hint
- optional timer or collectible counter placeholder

The HUD must support play, not engine inspection.

## Step 1: Building Blocks

### Goal

Introduce a reusable block catalog so the scene is assembled from named pieces instead of ad hoc cube spawns.

The first block system should stay simple:

- code-driven
- primitive-mesh based
- easy to theme
- easy to compose

This is not yet the text level format. It is the foundation that the future level format will target.

### Core Rule

Every visible gameplay piece should map to a block type with a stable meaning.

Bad:

- "spawn cube here with random tint"

Good:

- "spawn a start pad"
- "spawn a wide floor"
- "spawn a low wall"
- "spawn a ramp"
- "spawn a goal arch"

### Recommended First Block Catalog

#### Navigation Blocks

- `StartPad`
- `Floor`
- `Platform`
- `Ramp`
- `Step`
- `Bridge`

#### Containment Blocks

- `Wall`
- `Rail`
- `Barrier`

#### Landmark Blocks

- `GoalArch`
- `MarkerPole`
- `Banner`
- `CheckpointPad` (visual placeholder for now, even if not interactive yet)

#### Decoration Blocks

- `Tree`
- `Bush`
- `Pillar`
- `CloudMarker` or `FloatingOrb`

### Data Needed Per Block

Each block definition should own:

- transform inputs: position, rotation, scale
- visual style role
- physics behavior
- optional gameplay tag

This keeps block meaning above raw mesh details.

### Module Shape

The codebase should move toward a shape like this:

- `theme.vo`: palette, lighting, HUD style helpers
- `blocks.vo`: block definitions and spawn helpers
- `world.vo`: scene wiring, player, camera, and world lifecycle
- future `level.vo`: will later map level data to block instances

For this phase, `world.vo` should stop being the place where individual cubes are manually authored.

### Authoring Flow For This Phase

Before level files exist, the world should still be built through block calls, for example:

- `SpawnStartPad(...)`
- `SpawnFloor(...)`
- `SpawnRamp(...)`
- `SpawnWall(...)`
- `SpawnGoalArch(...)`

That way the next phase can translate text level data into exactly the same block API.

### Physics Rule

Do not create a separate rendering-only vocabulary and physics-only vocabulary.

Each block helper should spawn the visible shape and its intended collision in one place. The scene should be truthful by default.

## Explicit Non-Goals

The following are not part of this phase:

- text level file parsing
- multiple authored levels
- enemies
- power-ups
- audio polish
- advanced materials or imported art assets

If a task does not improve Step 0 or Step 1 directly, it should wait.

## Deliverables

This phase is done when MarbleRush has:

1. a coherent playful visual direction
2. debug-style HUD removed from normal play
3. a reusable block catalog in code
4. the current demo layout rebuilt using named blocks
5. clear module boundaries for future level loading

## Acceptance Criteria

Step 0 and Step 1 are successful when:

- a screenshot already reads as a game instead of a graphics test
- another developer can add a new obstacle without editing low-level mesh code
- future text level loading can target the block layer directly
- world assembly becomes easier, not harder

## Recommended Implementation Order

1. Remove debug-only HUD and overlay from normal play.
2. Introduce a `theme` layer for palette and lighting.
3. Introduce reusable block helpers with stable names.
4. Rebuild the existing demo course using those block helpers.
5. Add a few decorative landmark pieces so the course looks intentional.

## Notes For The Next Phase

When Step 2 begins, the level text format should instantiate this block catalog rather than bypass it.

That means Step 1 is not throwaway work. It is the contract for level authoring.
