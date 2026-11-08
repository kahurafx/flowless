# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/network`

Pure graph traces over the water network (Phase 2, ported from Majimap's `packages/network`): directional (upstream/downstream by hop distance from sources), isolation (valves to close, affected service connections), subnetwork membership, DMA membership, and geo helpers (`pointInRing`, `nearestPipe`). The API, web and mobile run the same functions, so a trace gives the same answer on the server and on an offline phone. Shared package conventions are in the root `CLAUDE.md`.

- Keep it pure: no database, I/O, clock, React or Node-only APIs. It must run in the Expo bundle and in Next.js. No workspace runtime dependencies.
- Inputs are structural (`TraceNode`, `TracePipe` in `src/types.ts`), so API rows, web data and the mobile cache pass in without conversion. Functions return the caller's own objects, not copies. Preserve that when changing them.
- `NodeType` / `NODE_TYPES` live in `src/types.ts` until the GIS module owns a node-type catalogue. Geo helpers use `LatLng { lat, lng }` (WGS84 degrees), not shared-types' `GeoPoint { latitude, longitude }`; convert at the call site.
- `isOpen: null` on a valve means unknown, which traces treat as open.
- Tests are colocated (`*.test.ts`, Vitest, shared fixtures in `src/test-fixtures.ts`): `pnpm --filter @flowless/network test`. No database needed.
