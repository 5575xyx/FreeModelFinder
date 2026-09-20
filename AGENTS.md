# AGENTS.md

## Project Overview

FreeModelFinder — pnpm monorepo that aggregates free LLM models from multiple providers into a local OpenAI/Anthropic/Gemini-compatible gateway.

## Monorepo Structure

| Package | Path | Description |
|---------|------|-------------|
| `@freemodelfinder/core` | `packages/core` | Provider logic, model registry, config, router |
| `@freemodelfinder/server` | `packages/server` | Fastify gateway (OpenAI/Anthropic/Gemini compatible) |
| `freemodelfinder` | `packages/cli` | CLI entrypoint (`fmf` command), publishes to npm |
| `@freemodelfinder/ui` | `packages/ui` | Next.js 16 Dashboard |
| `@freemodelfinder/desktop` | `apps/desktop` | Tauri macOS app (Rust + Node) |

## Requirements

- Node.js >= 22.14.0, pnpm 11 (via `corepack enable`)
- `corepack enable` before first install

## Essential Commands

```bash
pnpm install --frozen-lockfile          # install deps
pnpm format:check                       # prettier check (CI gate)
pnpm lint                               # eslint (packages/** only)
pnpm build:runtime                      # build core + server (required before typecheck/test)
pnpm typecheck                          # tsc --noEmit across all packages
pnpm test:coverage                      # all package tests with coverage
pnpm build                              # build CLI (bundles UI assets)
pnpm test:pack                          # smoke test the npm package
```

**CI order (must respect):** `format:check` → `lint` → `build:runtime` → `typecheck` → `test:coverage` → `build` → `audit:prod` → `verify:release` → `test:pack`

## Per-Package Dev/Test

```bash
pnpm dev:server                         # watch server (port 11435)
pnpm dev:ui                             # watch UI (port 3000)
pnpm --filter @freemodelfinder/core test         # core tests only
pnpm --filter @freemodelfinder/server test       # server tests only
pnpm --filter freemodelfinder test               # cli tests only
pnpm --filter @freemodelfinder/ui test           # ui tests only (vitest)
```

## Testing

- **core/server/cli:** Node.js built-in test runner (`node --test`), run via `tsx` loader. Tests live in `src/__tests__/` or `src/**/__tests__/`.
- **ui:** Vitest + React Testing Library + msw. Config at `packages/ui/vitest.config.ts`.
- **Docker:** `node --test scripts/docker.test.mjs` (requires Docker daemon running).
- Coverage thresholds enforced: core (85% lines, 74% branches), server (80%/75%), cli (80% lines).

## Linting

- ESLint with `@typescript-eslint` + `prettier` config. `@typescript-eslint/no-explicit-any` is off.
- Lint scope: `packages/**/*.{ts,tsx}` only. Does not lint scripts, apps, or config files.
- Max warnings = 0 (zero tolerance).

## Build System

- **tsup** for all packages (bundles to `dist/`). Config: `tsup.config.ts` per package.
- **core must build before server** (server depends on `@freemodelfinder/core: workspace:*`).
- **CLI build** runs `build:dependencies` first (ui → core → server), then tsup, then `copy-assets.mjs`.
- **UI:** Next.js 16, built with `next build`.

## Key Gotchas

1. **`build:runtime` before `typecheck`** — typecheck depends on built `.d.ts` from core/server.
2. **`pnpm install --frozen-lockfile`** — never `pnpm install` without `--frozen-lockfile` in CI or scripts.
3. **Windows paths** — scripts use forward slashes; PowerShell users should use `workdir` param.
4. **`noUncheckedIndexedAccess: true`** — TS strict mode with indexed access null checks.
5. **Desktop builds** need Rust 1.86+ and Xcode CLI Tools (macOS only).
6. **`pnpm test:pack`** — smoke tests the npm package output; runs after build.

## Daily Audit

- `pnpm audit:daily` — rebuilds runtime, fetches fresh free-model lists from providers, updates `FREE_MODELS.md` and `reports/`.
- Reports auto-commit via `daily-audit.yml` workflow.

## Environment

- Config dir: `~/.freemodelfinder` (overridable via `FREEMODELFINDER_HOME`).
- Gateway listens on `127.0.0.1:11435` by default.
- Proxy: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` supported for outbound provider requests.
