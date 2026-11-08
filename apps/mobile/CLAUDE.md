# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Mobile app (`mobile`)

The field app (U-02, Phase 2 W5): Expo SDK 58 / React Native 0.88 / React 19.3 / Expo Router, ported from Majimap's `apps/native` against the Flowless API. Offline-first technician app for jobs (W-01 to W-03) and the network map (G-01 to G-03). Repo-wide commands and layout are in the root `CLAUDE.md`; the API it calls is in `packages/api/CLAUDE.md` (Work Orders, GIS and files sections).

### Commands (run in `apps/mobile`)

```bash
pnpm start          # expo start --dev-client (also: pnpm android | ios, which build the dev client; pnpm web)
pnpm lint           # npx expo lint, with the shared flowless/module-boundaries rule
pnpm check-types    # tsc --noEmit
pnpm test           # vitest: pure TypeScript only (sync queue, ordering, permissions, ranking)
npx expo install <pkg>
npx expo export --platform android   # proves the bundle builds
```

Needs a development build, not Expo Go: `@maplibre/maplibre-react-native` and `expo-sqlite`/`expo-secure-store` config plugins add native code. After adding a package with native code run `npx expo prebuild --clean` then `npx expo run:android` (or `run:ios`). Never edit `ios/` or `android/`; configure native behaviour in `app.json`.

### Env

- `EXPO_PUBLIC_API_URL`: where the Flowless API (apps/web) is, e.g. `https://flowless.example`. Unset in development it is port 3000 on the machine serving the bundle (`Constants.expoConfig.hostUri`). See `.env.example`. A phone cannot reach `localhost`; use the machine's LAN address.
- `scheme` in `app.json` (`flowless`) must equal `MOBILE_APP_SCHEME` in `@flowless/shared-types`, which `packages/auth` trusts as an origin (Better Auth Expo plugin).
- Dev data: `pnpm db:seed` makes organization `MAJISAFI` (owner `wanjiru@majisafi.test`, staff `baraka`, `achieng`, `chebet` the technician), password `flowless-dev-password`.

### Structure

- `src/app/` routes (Expo Router, per `AGENTS.md`): `(auth)/sign-in`; `(app)/(tabs)/{index,map,assets,profile}` with a floating "+" quick-actions sheet; stack screens `work-orders`, `work-order/[id]/{index,finish,approve}`, `inspect/[id]`, `valve/[id]`, `asset/[id]`, `select-asset`, `add-asset`, `capture-connection`, `report`, `sync`, `review/{index,[branch]}`. Root `_layout` gates `(auth)` and `(app)` with `Stack.Protected`.
- `src/components/` UI. `ui.tsx` has the primitives (`Text`, `Button`, `Chip`, `Field`, `Row`, `Card`, `StatusPill`, ...); everything tappable is at least 44 points. `network-map.tsx` (MapLibre), `map-trace-panel.tsx`, `map-layers-sheet.tsx`, `attachment-picker.tsx`, `location-card.tsx`.
- `src/lib/` plain modules. `theme.ts` is the design tokens: hex values of `apps/web/src/app/globals.css` (light and dark), the type scale and radii. Style with `StyleSheet`/inline styles and `useTheme()`; there is no NativeWind (Majimap used a 5.0 release candidate, which is not worth the risk on SDK 58). The font is the system font (the web uses Inter).
- `src/lib/api.ts`: the tRPC client (`httpBatchLink` with the superjson transformer on the link, absolute URL) and the Better Auth client (`expoClient` with secure store). It imports `type { AppRouter } from "@flowless/api"` only; the lint rule refuses any runtime import from `@flowless/api`. `src/lib/types.ts` derives every server type from the procedures (`Out<typeof api.gis.nodes.list.query>`), so an API change is a compile error here. `tsconfig.json` has `"types": ["node"]` because the server's source is read for those types.
- `src/state/` app state, split by area, composed in `app.tsx` (`AppProvider`): `useSession()` (who, permissions as `abilities`, sign in/out), `useNetwork()` (map data), `useJobs()` (jobs and their actions), `useField()` (inspections, valves, capture), `useReview()` (branches to post), `useSync()` (queue, online, sync now), `useToast()`. Slice values are memoized and actions keep one identity (`use-actions.ts`), so a screen re-renders only for the area it reads.

### Sync, the ops queue and photos

- Field actions are local-first. Each one updates the phone at once and queues the exact tRPC calls it stands for as one `SyncItem` with its `Op`s (`src/lib/sync/ops.ts`). "Sync now", pull-to-refresh, reconnecting and returning to the foreground send the queue through `trpcTransport` (`src/lib/sync/transport.ts`) in creation order, then read everything again (`pull` in `state/app.tsx`). Lists are re-read only with nothing left to send, so unsent work never disappears from the screen.
- The run itself is `runQueue` (`src/lib/sync/queue.ts`), free of React and of the network. A thrown error means "didn't get through" (offline, 5xx, session ended, NOT_FOUND because something hasn't arrived): the item is `failed` and the run stops, so nothing overtakes it. A refusal (BAD_REQUEST, FORBIDDEN, CONFLICT) is a `rejected` outcome with the server's reason: that item stops, the queue carries on. `stale` keeps a log as history without changing the asset. Each item shows its worst answer (applied, unchanged, replayed, stale, rejected).
- Every id the phone makes is a client-minted uuid (`expo-crypto`), sent as the entity `id` or the action `eventId`, so a retried sync is safe: the server answers a repeat with `replayed` (or hands back the row it has). A retry resends the whole item with the same ids; never regenerate ids on retry. Dates are ISO strings in the queue and become `Date`s in the transport.
- Photos: `files.announce` (id, subject, size, geotag) returns a presigned PUT, the transport sends the bytes with `File.upload` (SDK 58 `expo-file-system`), then `files.confirm`. Subjects are `work_order` (a job) and `gis_asset` (a node, pipe, structure or connection). Order matters (`src/lib/sync/build.ts`): a job's photos are confirmed before its completing `workOrders.transition`, because the kind's evidence check counts only confirmed photos; a new asset's photos go after its create. Files are copied into the documents folder and the op holds a path relative to it. A server with no S3 settings (`memory://` upload URLs) answers the item as rejected.
- Where network changes go: a job whose kind works on the network (`gis` is not `none`) puts its logs, edits and creates on the job's branch `wo-<code>`, asked of the server when sent (`workOrders.changeSet`; a job raised on the phone has no code yet). Logs for other jobs go on main (that is where Work Orders links them from). With no job, a member who may post uses main; everyone else their personal branch `fld-<userId>`, which an engineer reviews. Branch proposals are overlaid on the live network after each pull (own personal branch and own open jobs).
- Storage: one expo-sqlite database per signed-in person (`src/lib/storage`), superjson documents. A layout effect in `state/app.tsx` commits each state change in one transaction before it reaches the screen. Signing out keeps the database.

### Rules of the road

- Permissions, not roles: `src/lib/permissions.ts` turns `access.me` plus the licensed modules (`entitlements.list` → `workLevel`) into `abilities`. They only hide UI; the server enforces them. A member without GIS licensed or `gis:read` gets no map or assets tabs.
- There is no people directory in the API, so other people show as "A teammate". Customers belong to Accounts: a captured connection has a number, a place and a pipe, and nothing else.
- A kind's completion data (`hasCapture`) has no schema on the wire; the forms the app knows are in `CAPTURE_FIELDS` (`src/lib/work-orders.ts`). An unknown kind says to finish it on the web.
- The unit tests import nothing from React Native or Expo. Keep new sync logic in such modules so it stays testable here; device behaviour (camera, GPS, MapLibre, the secure store) can only be checked on a device or emulator.
- This app uses TypeScript ~6 and `expo/tsconfig.base`, not `@flowless/typescript-config`. Depends on `@flowless/shared-types` and `@flowless/network` (raw TS via `workspace:*`; Metro resolves them from the pnpm workspace).
