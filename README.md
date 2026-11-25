# AgenticPress Breakage Check (`agenticpress-check`)

[![AgenticPress MCP connector](https://glama.ai/mcp/connectors/org.agenticpress/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/org.agenticpress/mcp)

Zero-dependency GitHub Action and CLI scanner that catches **deprecated AI models**, **EOL runtimes**, and **sunsetted platform dependencies** before merge—backed by primary-sourced vendor changelogs and official timelines from [AgenticPress](https://agenticpress.org).

## 6-Line GitHub Actions Setup

Add `.github/workflows/agenticpress.yml` to any repository:

```yaml
name: Breakage Check
on: [pull_request, push]
jobs:
  agenticpress:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: agenticpress-org/agenticpress-check@v1
```

Zero API keys, zero tokens, zero npm installs. Runs in ~2 seconds on Node 22+ (Node 24 LTS recommended).

## What It Scans

`agenticpress-check` walks your repository (respecting `.gitignore` and skipping `node_modules`, `dist`, `.venv`, `vendor`, etc.) and extracts targets from:

1. **`Dockerfile` / `*.dockerfile`**: `FROM` base images (`node:*`, `python:*`, `golang:*`, `alpine:*`, `ubuntu:*`, `postgres:*`)
2. **`package.json`**: `engines.node`
3. **`pyproject.toml`**: `requires-python`
4. **`go.mod`**: `go <version>`
5. **`.github/workflows/*.yml`**: `runs-on: ubuntu-*`, `node-version`, `python-version`, `go-version`
6. **Code & configs (optional, enabled by default)**: AI model IDs (`gpt-*`, `o1*`, `o3*`, `o4-mini*`, `text-embedding-*`, `claude-*`, `gemini-*`; skips docs, lockfiles, and test files)

Extracted targets are deduplicated and queried in batches of up to 15 via `GET https://agenticpress.org/api/check?targets=...`.

## Action Options

| Input | Default | Description |
| --- | --- | --- |
| `fail-on` | `sunset` | Failure threshold: `sunset` (fails on `DO_NOT_USE` / `SUNSET`), `deprecated` (also fails on `MIGRATE_SOON` / `DEPRECATED`), or `none` (advisory report only). |
| `scan-models` | `true` | Scan source & config files for AI model identifiers (`true` / `false`). |
| `comment-on-pr` | `false` | Create or update a sticky PR comment (`<!-- agenticpress-check-sticky -->`). Requires `permissions: { pull-requests: write }` in your workflow. |
| `working-directory` | `.` | Subdirectory to scan relative to the repository root. |
| `github-token` | `${{ github.token }}` | Token used when `comment-on-pr: 'true'`. |

### Outputs

- `checked-count`: Total unique targets checked
- `sunset-count`: Count of targets with `DO_NOT_USE` / `SUNSET`
- `migrate-soon-count`: Count of targets with `MIGRATE_SOON` / `DEPRECATED`
- `findings-count`: Sum of `sunset-count` + `migrate-soon-count`

## Quick CLI / 1-Line `curl` Check

Check any list of runtimes or AI models right from your terminal:

```bash
curl -s "https://agenticpress.org/api/check?targets=gpt-4o,claude-3-5-sonnet-20241022,node:18,python:3.12" | jq
```

Or run the scanner locally against the current directory:

```bash
node ./scripts/check.mjs
```

## Connect the AgenticPress MCP Server (`org.agenticpress/mcp`)

Give your coding agent real-time access to all 9 Breakage Shield MCP tools (`check_status`, `check_batch`, `get_recommended`, `get_upcoming_deadlines`, `list_entities`, `search_claims`, `get_entity`, `get_entity_history`, `get_latest_updates`) over hosted Streamable HTTP—zero local install required.

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agenticpress": {
      "url": "https://agenticpress.org/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http agenticpress https://agenticpress.org/mcp
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "agenticpress": {
      "type": "http",
      "url": "https://agenticpress.org/mcp"
    }
  }
}
```

### Antigravity / Generic MCP Clients

```json
{
  "mcpServers": {
    "agenticpress": {
      "serverUrl": "https://agenticpress.org/mcp"
    }
  }
}
```

### Agent Skill (`skill.md`)

Install or point your coding agent directly to the machine-readable playbook:

- [`https://agenticpress.org/skill.md`](https://agenticpress.org/skill.md)

### Slack RSS Alerts

Stay notified in Slack whenever official vendor deprecation or limit changes land:

```text
/feed subscribe https://agenticpress.org/feed.xml
```

## Explore AgenticPress Reference Hubs

- [Upcoming Breakage Deadlines](https://agenticpress.org/deadlines)
- [Active vs. Deprecated AI Models](https://agenticpress.org/models)
- [Serverless & Cloud Hard Limits](https://agenticpress.org/limits)
- [Active Runtime & OS EOL Matrix](https://agenticpress.org/runtimes)
- [Verification & Primary-Source Methodology](https://agenticpress.org/methodology)

## License

[MIT](./LICENSE)
