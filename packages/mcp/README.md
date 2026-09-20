# @multiloger/mcp — Multiloger MCP Server

An MCP server (stdio transport) that exposes Multiloger browser-profile
management and automation as tools for MCP clients (Claude Desktop, IDE
assistants, etc.).

**Architecture: API consumer only.** This server never spawns browsers, never
touches the Multiloger SQLite database, and never imports from
`@multiloger/api`. Every tool makes exactly one authenticated HTTP call to
the Multiloger REST API and returns a human-readable summary.

## Environment

| Variable               | Required | Default                 | Purpose                         |
| ---------------------- | -------- | ----------------------- | ------------------------------- |
| `MULTILOGER_API_URL`   | no       | `http://127.0.0.1:3000` | Base URL of the Multiloger API  |
| `MULTILOGER_API_TOKEN` | **yes**  | —                       | Bearer token sent on every call |

The server exits with an error on stderr if `MULTILOGER_API_TOKEN` is missing.
All logging goes to stderr — stdout is reserved for the MCP protocol channel.

## Build & run

```bash
# from the repo root
pnpm --filter @multiloger/mcp build

# run (needs the API up and a token)
MULTILOGER_API_URL=http://127.0.0.1:3000 \
MULTILOGER_API_TOKEN=<token> \
node packages/mcp/dist/index.js
```

## Claude Desktop config

Add to `claude_desktop_config.json` (use the absolute path to the built file):

```json
{
  "mcpServers": {
    "multiloger": {
      "command": "node",
      "args": ["/absolute/path/to/Multiloger/packages/mcp/dist/index.js"],
      "env": {
        "MULTILOGER_API_URL": "http://127.0.0.1:3000",
        "MULTILOGER_API_TOKEN": "<your-api-token>"
      }
    }
  }
}
```

## Tools

| Tool                 | What it does                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_profiles`      | List all browser profiles with state (read-only).                                                                                             |
| `get_profile_status` | Full status of one profile: state, proxy requirement, last PID/CDP port, last launch time (read-only).                                        |
| `launch_profile`     | Launch a profile's Chromium via the API; returns state. The raw CDP endpoint is never exposed — all browser interaction stays behind the API. |
| `stop_profile`       | Stop a profile's running browser via the API.                                                                                                 |
| `list_scripts`       | List saved automation scripts (read-only).                                                                                                    |
| `create_script`      | Create a reusable automation script from declarative steps (see below).                                                                       |
| `run_job`            | Start a job that runs a script against a profile. **Only runs against an already-running profile** — it never launches a browser.             |
| `list_jobs`          | List automation jobs with status (read-only).                                                                                                 |
| `get_run_status`     | Run status, start/finish times, error, per-step summary, and captured artifacts (read-only).                                                  |
| `get_run_logs`       | Timestamped log lines of a run (read-only).                                                                                                   |
| `get_run_artifact`   | Download one screenshot artifact (e.g. `2.png`) and return it as an image (read-only).                                                        |
| `cancel_job`         | Cancel a job and its in-flight runs.                                                                                                          |
| `whoami`             | Show the identity this server acts as: token kind, roles, permissions, scopes (read-only).                                                    |
| `audit_log`          | Query the audit log with filters (read-only; requires `audit:read`).                                                                          |

Tool failures surface the API's own error code and message, e.g.
`API error [PROFILE_NOT_FOUND] (HTTP 404): No such profile`.

## Scoped tokens (Phase 3 team management)

The MCP server uses **one** API token for all tools. That token can be:

- a **legacy token** (created before team management, or with no user) — full
  access to everything, including user administration. Convenient for a
  personal setup; do not hand it to an agent you would not trust with the
  dashboard's Team page.
- a **user-attributed, scope-narrowed token** — least privilege for agents.
  Create one as an admin:

```bash
# 1. create the user (admin, via the bootstrap/legacy token)
curl -s -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"Agent","email":"agent@example.com","password":"a-very-long-password-1","roleIds":["operator"]}' \
  http://127.0.0.1:3000/v1/users

# 2. grant the client(s) the agent may touch
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"clientId":"<client-id>"}' \
  http://127.0.0.1:3000/v1/users/<user-id>/clients

# 3. issue a narrowed token: read + automation only, no user admin
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"mcp-agent","scopes":["profiles:read","profiles:launch","profiles:stop","automation:read","automation:scripts:manage","automation:run","audit:read"]}' \
  http://127.0.0.1:3000/v1/users/<user-id>/tokens
```

Then point `MULTILOGER_API_TOKEN` at the issued token. Scopes can only
**narrow** the user's role permissions, never widen them. Tools the token is
not allowed to use fail with a clear error, e.g.
`API error [FORBIDDEN] (HTTP 403): Missing permission: automation:run`.
The `whoami` tool reports the effective identity, so an agent can check its
own capabilities before acting.

## Automation step language

`create_script` accepts an ordered JSON array of steps. Each step is one of:

- `{"type":"navigate","url":"https://..."}` — http/https URLs, or `data:text/html,` for a hermetic synthetic page
- `{"type":"wait","ms":1000}`
- `{"type":"waitForSelector","selector":"css","timeoutMs":10000}`
- `{"type":"evaluate","expression":"document.title","timeoutMs":15000}`
- `{"type":"getText","selector":"css","timeoutMs":10000}`
- `{"type":"screenshot","fullPage":false}`

Steps execute inside the API's sandboxed declarative step engine against the
target profile's already-running browser. No arbitrary code leaves this
process.

## Security notes

- **Token handling:** the API token is read once from process env and stored
  only in the HTTP client. Tools never accept it as an argument and never
  include it in their output.
- **API-only:** this package cannot launch browsers, read the database, or
  bypass Multiloger access controls — it is limited to what the REST API
  (and its token auth + rate limits) allows.
- **No CAPTCHA solving / anti-detect / ban-evasion** features exist in this
  package, by design.
- Treat the API token like a password: keep it out of chat transcripts and
  config files that get shared.
