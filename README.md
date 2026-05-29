# mock-server-automation

CLI utility on top of [Microcks](https://microcks.io) that ingests OpenAPI / Postman specs, spins up Microcks + a mock-OAuth2 server in containers, runs a stateful HTTP gateway, mints credentials, and (optionally) exposes everything through a Cloudflare quick tunnel.

```
                                         ┌────────────────────────┐
                                         │  mock-oauth2-server    │
  client ──► gateway (Express :3000) ───►│  /token /jwks /...     │
              │                          └────────────────────────┘
              │   auth check, stateful CRUD,
              │   pagination, JSON-schema validation
              ▼
         Microcks (:8585) ─── serves the OpenAPI / Postman mocks
```

## Prerequisites

- **Node.js ≥ 18** — runs the CLI itself.
- **Docker** (or Podman) — runs the Microcks + mock-oauth2 containers. Needed for `mock up` / `mock down`.
- **`cloudflared`** (optional) — only needed for `mock tunnel`. Install with `brew install cloudflared` or grab a binary from [cloudflared releases](https://github.com/cloudflare/cloudflared/releases).

## Install

```bash
# From a release tarball your team shares:
npm install -g ./mock-server-automation-X.Y.Z.tgz

# Or from a git URL:
npm install -g git+ssh://git@github.com/<org>/mock-server-automation.git
```

Verify:

```bash
mock --version
mock --help
```

## Quick start

```bash
mkdir my-mocks && cd my-mocks
mock init              # scaffolds ./specs and ./data
mock up                # starts microcks + mock-oauth2 (first run pulls images, ~30s)
mock import            # interactive: paste a URL or pick a local OpenAPI/Postman file
mock serve             # gateway on http://localhost:3000

# In another shell, hit the mock:
curl http://localhost:3000/mock/<system>/<endpoint>
```

## All 17 commands

| Command | What it does |
|---|---|
| `mock init` | Scaffold `./specs` and `./data` in the current directory. |
| `mock up` | Start the Microcks + mock-oauth2 containers. |
| `mock down` | Stop the containers. |
| `mock import` | Interactive: fetch a spec from URL or pick a local file, derive `vendor.json`, ingest. |
| `mock add <system>` | Upload `specs/<system>/*` into Microcks. |
| `mock sync` | Upload every system under `specs/*` (idempotent). |
| `mock remove <system>` | Remove a system from Microcks. |
| `mock list` | List configured systems and whether they're loaded. |
| `mock info <system>` | Print spec details, resources, security schemes, public URL. |
| `mock serve` | Start the HTTP gateway on `:3000` (auth → stateful → Microcks). |
| `mock tunnel up/down/status/url` | Manage a Cloudflare quick tunnel to your local gateway. |
| `mock create <sys> <res>` | Create a stateful entity (validates against the spec). |
| `mock update <sys> <res> <id>` | Replace a stateful entity by id. |
| `mock get <sys> <res> [id]` | Fetch one entity or list a collection. |
| `mock delete <sys> <res> <id>` | Delete a stateful entity by id. |
| `mock reset <sys> [res]` | Clear all stored data for a system or one resource. |
| `mock resources <system>` | List detected stateful resources and record counts. |
| `mock token <system>` | Mint credentials matching the spec (Basic / Bearer / apiKey / OAuth2 JWT). |

Run `mock <command> --help` for flags.

## Where things live

| Path | Purpose | Scope |
|---|---|---|
| `./specs/<system>/openapi.yaml` (or `.json`) | API spec you imported | per-project (CWD) |
| `./specs/<system>/vendor.json` | Display name, auth type, scopes | per-project (CWD) |
| `./data/<system>.json` | Stateful records created by `mock create`/`update` | per-project (CWD) |
| `~/.mock-server-automation/state.json` | Tunnel PID + URL | per-user |
| `~/.mock-server-automation/tunnel.log` | `cloudflared` logs | per-user |

Override with `MOCK_HOME=/abs/path` and `MOCK_STATE_DIR=/abs/path` env vars.

## Environment variables

| Var | Default | What it does |
|---|---|---|
| `MICROCKS_URL` | `http://localhost:8585` | Where the CLI talks to Microcks. |
| `OAUTH_URL` | `http://localhost:8181` | Where the gateway proxies OAuth endpoints. |
| `PORT` | `3000` | Gateway port. |
| `PUBLIC_BASE_URL` | _(unset)_ | When set, the gateway uses this in `next_page` URLs instead of the request Host. Required behind a reverse proxy. |
| `TRUST_PROXY` | auto | Forces Express to honour `X-Forwarded-*`. Auto-on when `PUBLIC_BASE_URL` is set. |
| `MOCK_HOME` | `cwd` | Override where `specs/` and `data/` live. |
| `MOCK_STATE_DIR` | `~/.mock-server-automation` | Override where tunnel state lives. |

## Hosted deployment

For 24/7 mocks behind your own domain with auto-TLS, use the production stack (`docker-compose.prod.yml`) bundled in the source repo (not in the npm tarball). End users then just hit `https://your-host/mock/<system>/...` — no install required. See the full deployment guide in `docs/06-deployment.md` in the source repo.
