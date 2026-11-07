# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Mobile app (`mobile`)

Expo SDK 58 / React Native 0.88 / React 19.3. Repo-wide commands and layout are in the root `CLAUDE.md`.

### Commands (run in `apps/mobile`)

```bash
pnpm start          # expo start (also: pnpm android | ios | web)
pnpm check-types    # tsc --noEmit
npx expo lint       # no lint script in package.json, so root `pnpm lint` skips this app
npx expo install <pkg>
```

### Notes

- Current state is the blank template: `index.ts` calls `registerRootComponent(App)` from `App.tsx`. Expo Router (per `AGENTS.md`) is not installed yet — adopting it means installing `expo-router`, setting `"main": "expo-router/entry"` in `package.json`, and moving screens into `src/app/`.
- This app uses TypeScript ~6 and `expo/tsconfig.base`, not `@flowless/typescript-config`.
- Depends on `@flowless/shared-types` (raw TS via `workspace:*`); Metro resolves it from the pnpm workspace.
- The Expo Claude plugin is enabled in `.claude/settings.json`.
