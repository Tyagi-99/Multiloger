# Multiloger

Professional multi-profile Chromium platform for freelancers and teams managing
many isolated client browser environments: persistent profiles, per-profile
proxies, automation via Playwright/CDP, backups, audit logs, and a central
dashboard.

> **Design boundary:** Multiloger is built for legitimate multi-client
> management, isolation, privacy, and automation. It does not include features
> whose primary purpose is bypassing platform security, evading fraud
> detection, defeating CAPTCHAs, circumventing account bans, impersonating real
> people, or defeating anti-abuse systems.

## Monorepo layout

- `packages/shared` — shared TypeScript types and utilities
- `packages/api` — control-plane API server (Node.js + TypeScript)
- `packages/web` — dashboard frontend (React + Vite, added in Task 10)

## Requirements

- Node.js 22+ (see `.nvmrc`)
- pnpm 9 (`npm i -g pnpm@9.15.0`)

## Quick start

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Running the server

The API server (plus the built dashboard) starts through the `multiloger`
CLI in `packages/api`:

```sh
# Development (dashboard auto-served when packages/web is built)
pnpm build
pnpm --filter @multiloger/api start

# …or after `pnpm pack` / a global install:
multiloger --port 3000 --data-dir ./multiloger-data
```

On first start with no API tokens, a **bootstrap token is printed once** —
save it immediately, then create a named token via the dashboard
(Settings → API tokens) or `POST /v1/tokens`. The dashboard is served at
`http://127.0.0.1:3000/` (default bind is loopback only).

Configuration precedence: **CLI flag > `MULTILOGER_*` env var > default**.

| Flag              | Env var                     | Default                                         |
| ----------------- | --------------------------- | ----------------------------------------------- |
| `--host`          | `MULTILOGER_HOST`           | `127.0.0.1`                                     |
| `--port`          | `MULTILOGER_PORT`           | `3000`                                          |
| `--data-dir`      | `MULTILOGER_DATA_DIR`       | `./multiloger-data`                             |
| `--db-path`       | `MULTILOGER_DB_PATH`        | `<data-dir>/multiloger.db`                      |
| `--chromium-path` | `MULTILOGER_CHROMIUM_PATH`  | auto-detect                                     |
| `--web-dir`       | `MULTILOGER_WEB_DIR`        | auto-detect `../web/dist` (API-only if missing) |
| `--headful`       | `MULTILOGER_HEADLESS=false` | headless                                        |

Encrypted backups additionally need one of:

- `MULTILOGER_BACKUP_KEY` — 64 hex chars (32 bytes), or
- `MULTILOGER_BACKUP_KEY_FILE` — path to a file holding the key (mode `0600`).

Without a key, backup endpoints answer `503`; backup files are AES-256-GCM
(`.mlbackup`). Backup records intentionally survive profile deletion (no
foreign key); restoring after the source profile is gone requires an
explicit `clientId`.

Proxy authentication is **not supported in this build**: assigning a proxy
with credentials fails closed (`409 PROXY_AUTH_UNSUPPORTED`) instead of
launching unauthenticated.

### Production notes

- Bind to loopback and put a reverse proxy (nginx/Caddy) in front for TLS;
  terminate TLS there and forward to `127.0.0.1:3000`.
- Keep `MULTILOGER_BACKUP_KEY_FILE` at mode `0600`, owned by the service user.
- Request logs never include headers or bodies — only method, path, status,
  duration, and the token id. Tokens and proxy credentials are never returned
  by the API or written to logs.

## Security model (summary)

- Token auth on every `/v1/*` route; per-token and anonymous rate limits.
- One `--user-data-dir` per profile; the single central launcher
  (`packages/api/src/browser/launcher.ts`) is the only code that spawns
  Chromium.
- Proxy leak guards: WebRTC is disabled and DNS/proxy bypass rules are
  enforced per profile.
- No features for bypassing platform security, fraud detection, CAPTCHAs,
  account bans, or anti-abuse systems — by design.
