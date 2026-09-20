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
