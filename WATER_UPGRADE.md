# Island 25: Water Upgrade

Based on https://github.com/youssef22karam/island25.

## Rendering Changes

- One cached freshwater-coverage field is shared by the ocean, terrain atlas, and freshwater geometry. Wet swamp cells retain full coverage even where their hydrology influence is below one.
- Removed vertex-depth opacity ramps. Bank contact is calculated per fragment from the terrain heightfield, with a pixel-sized anti-aliasing feather instead of a transparent band across whole triangles.
- Replaced the freshwater surface shader with depth-based light absorption, olive-jade swamp scattering, restrained tannin color, three-scale flow-advection, rain rings, wake interaction, irregularly scattered duckweed, and filtered planar reflections.
- Removed the fixed-distance refraction cutoff responsible for circular changes in water appearance from above.
- Retained lake, river, swamp, ocean, walking, boat, diving, weather, time, audio, screenshot, and atlas controls.
- Added GPU-frame back-pressure to prevent slow graphics devices from building up a queue of rendered frames. Underwater vegetation is only grown while submerged, and distant island generation is deferred.
- The React UI stores a small atlas-directory snapshot rather than the entire generated terrain. Atlas pixels are drawn on demand from the engine.
- Open-pool viewpoint selection keeps the starting camera out of reeds and roots. Travel animations follow elapsed time rather than slowing indefinitely with the graphics frame rate.

The photograph is an illustrated loading backdrop, not a substitute for the live 3D renderer. After generation, the procedural island and the revised water shaders are displayed.

## Run And Verify

```sh
npm install
npm run dev
node tools/verify-water.mjs
npx tsc --noEmit
npm run build
```

Balanced rendering, including live reflections, is the default. High and Ultra are available in Conditions > System. The terrain and foliage remain procedurally generated; this update does not replace them with photogrammetry assets.

The original byte-part workflow is preserved in `tools/split.mjs` and `tools/reassemble.mjs`. After editing a generated whole, split it before reassembling from its parts. Whole files are also included here so the standard Vite commands work without a prebuild hook.