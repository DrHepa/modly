# Modly Roadmap

## Current focus: Worlds

Worlds is now the primary scene-composition surface for browsing workspace assets, loading multiple renderables, arranging them in a scene, and preparing composed scenes for future save/export workflows.

### Completed

- ✅ Added the initial Worlds tab shell.
- ✅ Added immersive Worlds navigation with a dedicated viewer, independent from Generate `Viewer3D`.
- ✅ Resolved workflow renderables for Worlds, including WorldMirror/HY-World bundle outputs.
- ✅ Added PLY-capable rendering for standard PLY mesh/point assets and GLB/GLTF assets.
- ✅ Stabilized camera controls:
  - wheel zoom;
  - right-drag pan;
  - left-drag camera look;
  - WASD/arrow movement;
  - deterministic Reset Camera behavior.
- ✅ Added multi-asset scene editing:
  - add multiple assets to the current Worlds scene;
  - select assets from canvas or toolbar dropdown;
  - move/rotate/scale selected asset with TransformControls;
  - remove selected asset from the in-memory scene;
  - keep scene state across tab changes;
  - avoid intrusive centered loading text when adding assets;
  - avoid camera jumps on remove;
  - maintain selected asset during transform interactions.
- ✅ Improved selection UX:
  - BVH-accelerated raycast for real meshes;
  - fallback selection hitboxes;
  - visible violet selection silhouette;
  - rigged GLB cloning via `SkeletonUtils.clone`.
- ✅ Shared Workspace Library UI between Generate and Worlds:
  - shared search;
  - shared sort;
  - scope/capability grouping;
  - collapsible sections;
  - shared styling and openability messaging hooks.

### Follow-ups

#### Workspace Library

- 🔲 Validate the shared library visually in Generate and Worlds.
- 🔲 Keep refining Worlds-specific openability messages for scene manifests, generated worlds, Gaussian/SPZ assets, and unsupported files.
- 🔲 Avoid reintroducing Worlds-only endless flat asset lists; new library behavior must stay shared with Generate.

#### Scene composition UX

- 🔲 Add a concept of one or more base scene/world assets so newly added objects can be placed relative to the chosen scene space.
- 🔲 Preserve camera position more intentionally across add/remove/load operations while still supporting explicit Reset Camera.
- 🔲 Improve placement heuristics for large worlds versus small props/characters.
- 🔲 Consider multi-select for batch transform/remove after single-select editing is stable.

#### Scene persistence

- 🔲 Save/export a composed Worlds scene with multiple assets and transforms.
- 🔲 Import/open a saved composed scene back into Worlds.
- 🔲 Define a durable scene manifest contract for placed assets, transforms, base-scene roles, and provenance.
- 🔲 Connect saved Worlds scenes to existing `scene-manifest` and `generate/from-scene` contracts where appropriate.

#### Rendering support

- 🔲 Add SPZ/Gaussian splat support or conversion path for WorldMirror Gaussian outputs.
- 🔲 Improve outline/postprocessing reliability; keep deterministic silhouette fallback until postprocessing is proven stable.
- 🔲 Continue validating rigged/skinned GLB assets in multi-instance scenes.

#### Product validation

- 🔲 Validate real HY-World/WorldMirror outputs in Worlds after each viewer/library change.
- 🔲 Keep Worlds visually immersive: no metadata inspector, raw JSON panels, or dominant boxed layouts.
- 🔲 Keep Worlds and Generate viewers separate while sharing contracts and reusable UI where appropriate.
