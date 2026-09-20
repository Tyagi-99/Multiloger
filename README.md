# Multiloger

Professional multi-profile Chromium platform for freelancers and teams managing
many isolated client browser environments: persistent profiles, per-profile
proxies, automation via raw CDP, backups, audit logs, and a central
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
(API tokens page) or `POST /v1/tokens`. The dashboard is served at
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

## Team management + RBAC

Multiloger supports multiple users with role-based permissions and
per-client/per-profile scoping. **Existing setups are unaffected:** tokens
created before this feature (including the bootstrap token) are _legacy
tokens_ with full access — nothing changes for a single-user install.

### Concepts

- **Users** sign in with email + password (scrypt-hashed, never stored in
  plaintext) and are issued user-attributed API tokens.
- **Roles** bundle permissions. Built-in: `admin` (everything), `operator`
  (day-to-day profile/automation/backups work, no user admin), `viewer`
  (read-only). Custom roles can be created via `POST /v1/roles`.
- **Token scopes** narrow a token to a subset of the user's permissions.
  Scopes can only _remove_ access, never grant more than the role allows.
  Unknown scope keys are rejected.
- **Client/profile scoping**: a non-admin user only sees and touches the
  clients/profiles explicitly granted to them. Everything else answers `403`
  (existence is never leaked via `404`).
- **Audit log**: every mutating API call appends an entry (actor, action,
  entity, IP). No request bodies, passwords, or secrets are recorded.

### Setting up the first team

Run these with the bootstrap/legacy token (`$ADMIN`):

```bash
# 1. create the first admin user
curl -s -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"You","email":"you@example.com","password":"a-very-long-password-1","roleIds":["admin"]}' \
  http://127.0.0.1:3000/v1/users

# 2. invite a teammate (token is shown ONCE — deliver it yourself;
#    Multiloger does not send email)
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"email":"teammate@example.com","roleId":"operator","clientIds":["<client-id>"],"expiresInHours":72}' \
  http://127.0.0.1:3000/v1/invitations
# → { "invitation": {...}, "token": "mli_..." }

# teammate redeems (single-use, expires):
curl -s -X POST -H 'content-type: application/json' \
  -d '{"token":"mli_...","name":"Teammate","password":"their-very-long-password-1"}' \
  http://127.0.0.1:3000/v1/invitations/redeem
```

Password login issues a token attributed to the user:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"email":"teammate@example.com","password":"their-very-long-password-1"}' \
  http://127.0.0.1:3000/v1/auth/login
# → { "user": {...}, "token": { "token": "mlt_..." } }
```

The dashboard sign-in screen offers both **API token** and **Email + password**
tabs; the Team and Audit log pages appear in the sidebar for users whose
permissions allow them.

### Useful endpoints

| Task                            | Endpoint                                                 |
| ------------------------------- | -------------------------------------------------------- |
| Identity & permissions          | `GET /v1/auth/me`                                        |
| Change own password             | `POST /v1/auth/password`                                 |
| Manage users/roles/scopes       | `/v1/users/*`, `/v1/roles`                               |
| Issue a scoped token for a user | `POST /v1/users/:id/tokens`                              |
| Query audit log                 | `GET /v1/audit-log?action=…&actorId=…&limit=50&offset=0` |

Non-admin callers querying the audit log only ever see their own actions.
The MCP server can run on a narrowed token — see `packages/mcp/README.md`
("Scoped tokens") — and exposes `whoami` / `audit_log` tools.

### Upgrading an existing database

Migration `008-teams` runs automatically on startup. It adds the team tables
and three nullable columns on `api_tokens`; existing tokens keep working
with full (legacy) access. Roll back with `migrateDown` if needed — the
migration is fully reversible.
