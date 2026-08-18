# @lucasschirm/claude-session-sync

A [Claude Code](https://code.claude.com/) plugin that synchronizes your session
data — transcripts, workspace configuration, and session telemetry — to
S3-compatible storage via the [`@lucasschirm/sal-sync`](../../sync) engine.

## What it does

Every Claude Code session goes through a lifecycle: start, tool calls, context
compaction, subagent spawns, and stop. This plugin hooks into those lifecycle
events to capture and upload session artifacts so they can be analyzed later by
the [Agentic Sessions Dashboard](../../../) (or any consumer of the sync
engine's output).

### Hooks

The plugin registers hooks for the following Claude Code lifecycle events
(defined in [`hooks/hooks.json`](hooks/hooks.json)):

| Event          | What happens                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `SessionStart` | Records the session, spawns a detached transcript watcher that uploads incremental transcript deltas. |
| `PreCompact`   | Flushes pending transcript deltas before context compaction.                                          |
| `PostCompact`  | Resumes capture after compaction.                                                                     |
| `Stop`         | Flushes a final delta when the turn ends.                                                             |
| `StopFailure`  | Flushes a final delta when the turn ends due to an API error.                                         |
| `SubagentStop` | Flushes subagent transcript deltas when a subagent finishes.                                         |
| `SessionEnd`   | Performs the final sync: flushes remaining deltas, uploads the session manifest, and shuts down.      |

All hooks except `SessionEnd` run asynchronously (`"async": true`) so they
never block Claude. `SessionEnd` has a 60-second timeout to ensure the final
manifest is uploaded before the process exits.

### What gets captured

The sync engine captures only the artifacts in its versioned
[allowlist](../../sync/src/allowlist.ts):

- **Session & subagent transcript JSONL files** — captured raw by default,
  subject to size limits. Opt out with `SAL_CAPTURE_TRANSCRIPTS=false`.
- **Workspace configuration** — `CLAUDE.md`, `.mcp.json`,
  `.claude/settings.json`, `.claude/settings.local.json`,
  `.claude/agents/**`, `.claude/skills/**`, `.claude/rules/**`.
- **Global configuration** — `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
  `~/.claude/agents/**`, `~/.claude.json`.
- **Session telemetry** — `sessionId`, `projectId`, `harness`,
  `harnessVersion`, `model`, `startedAt`, `endedAt`, `durationMs`,
  `endReason`.

Configuration artifacts are sanitized before upload: known sensitive fields
(`env`, `password`, `secret`, `token`, `apiKey`, `authorization`, etc.) are
redacted, and bearer tokens, credential-bearing URLs, and private-key blocks
are stripped. See the full [privacy policy](../../sync/POLICY.md).

## Installation

The plugin is distributed through the `session-analyzer` marketplace, which is
hosted in this repository at
[`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json).
Installation is a two-step process: first add the marketplace, then install
the plugin.

### Step 1 — Add the marketplace

You can add the marketplace from GitHub, a git URL, or a local clone.

#### From GitHub (recommended)

Use the `owner/repo` shorthand:

```bash
claude plugin marketplace add lucasschirm/session-analyzer
```

Pin to a specific branch or tag with `@ref`:

```bash
claude plugin marketplace add lucasschirm/session-analyzer@feature/claude-session-sync
```

#### From a git URL

For non-GitHub hosts or explicit HTTPS cloning:

```bash
claude plugin marketplace add https://github.com/lucasschirm/session-analyzer.git
```

#### From a local clone (for development)

If you have this repo cloned locally:

```bash
claude plugin marketplace add ./path/to/session-analyzer
```

#### Marketplace scope

The `--scope` flag controls who sees the marketplace declaration:

| Scope     | Setting file                   | Shared with team? |
| --------- | ------------------------------ | ----------------- |
| `user`    | `~/.claude/settings.json`      | No (personal)     |
| `project` | `.claude/settings.json`        | Yes (committed)   |
| `local`   | `.claude/settings.local.json`  | No (gitignored)   |

```bash
# Share the marketplace with your team
claude plugin marketplace add lucasschirm/session-analyzer --scope project
```

### Step 2 — Install the plugin

Once the marketplace is added, install the plugin:

```bash
claude plugin install claude-session-sync@session-analyzer
```

Or from inside an interactive Claude Code session:

```
/plugin install claude-session-sync@session-analyzer
```

The install command opens a details view where you select an installation
scope (user, project, or local — same semantics as above). After installing,
run `/reload-plugins` if prompted.

### From source (local development)

For local development, build the plugin bundle first, then add the marketplace
from your local clone:

```bash
# Build the plugin bundle (esbuild single-file executables)
pnpm --filter @lucasschirm/claude-session-sync build

# Add the local marketplace and install
claude plugin marketplace add .
claude plugin install claude-session-sync@session-analyzer
```

The build produces self-contained executables in `bin/` (no `node_modules`
required at runtime):

```
bin/session-start        # SessionStart hook entry point
bin/session-end          # SessionEnd hook entry point
bin/hook                 # PreCompact/PostCompact/Stop/StopFailure/SubagentStop
bin/transcript-watcher   # Detached watcher process spawned by session-start
```

### Updating

To pull the latest version from the marketplace:

```bash
claude plugin marketplace update session-analyzer
claude plugin update claude-session-sync@session-analyzer
```

Or inside an interactive session:

```
/plugin marketplace update session-analyzer
/plugin update claude-session-sync@session-analyzer
```

### Uninstalling

```bash
claude plugin uninstall claude-session-sync@session-analyzer
claude plugin marketplace remove session-analyzer
```

## Configuration

The sync engine is configured entirely through environment variables. Set them
in one of the Claude Code settings files (see below), or export them in your
shell before launching `claude`.

### Required

| Variable             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `SAL_PROJECT_ID`     | Unique identifier for the project (e.g. `my-app`).    |
| `SAL_STORAGE_TYPE`   | Storage backend. Currently only `s3` is supported.    |
| `SAL_STORAGE_BUCKET` | S3 bucket name.                                       |
| `SAL_STORAGE_REGION` | AWS region (e.g. `us-east-1`).                        |
| `SAL_STORAGE_ID`     | AWS access key ID.                                    |
| `SAL_STORAGE_SECRET` | AWS secret access key.                                |

### Optional

| Variable                       | Default     | Description                                                        |
| ------------------------------ | ----------- | ------------------------------------------------------------------ |
| `SAL_STORAGE_ENDPOINT`         | _(none)_    | Custom S3-compatible endpoint (e.g. `http://localhost:4566` for LocalStack). |
| `SAL_STORAGE_SESSION_TOKEN`    | _(none)_    | Temporary AWS session token (for STS credentials).                |
| `SAL_SYNC_DISABLED`            | `false`     | Set to `true` to fully disable synchronization.                   |
| `SAL_CAPTURE_TRANSCRIPTS`      | `true`      | Set to `false` to skip transcript capture (config still syncs).   |
| `SAL_SYNC_TIMEOUT`             | `30000`     | Per-upload timeout in milliseconds.                               |
| `SAL_SYNC_RETRIES`             | `3`         | Number of retry attempts on upload failure.                       |
| `SAL_SESSION_END_BUDGET_MS`    | `120000`    | Time budget for the final SessionEnd sync in milliseconds.        |
| `SAL_HOOK_UPLOAD_TIMEOUT`      | `10000`     | Per-hook upload timeout in milliseconds.                          |
| `SAL_MAX_FILE_BYTES`           | `10485760`  | Max size per uploaded file (10 MB).                               |
| `SAL_MAX_TOTAL_BYTES`          | `104857600` | Max total bytes per sync run (100 MB).                            |
| `SAL_MAX_FILES`                | `1000`      | Max files per sync run.                                           |
| `SAL_MAX_TRANSCRIPT_BYTES`     | `52428800`  | Max transcript file size (50 MB).                                 |
| `SAL_MAX_JSON_DEPTH`           | `128`       | Max JSON nesting depth for sanitization.                          |
| `SAL_MAX_JSONL_LINE_BYTES`     | `1048576`   | Max bytes per JSONL line (1 MB).                                  |

### Configuring via Claude Code settings

Claude Code reads environment variables from the `env` key in its settings
files. There are three relevant scopes:

| File                          | Scope                          | Commit to git? |
| ----------------------------- | ------------------------------ | -------------- |
| `~/.claude/settings.json`     | You, in every project          | No             |
| `.claude/settings.json`       | Everyone in the project        | Yes            |
| `.claude/settings.local.json` | You, in this project only      | No (gitignored)|

#### Option A: User-wide (recommended for personal use)

Edit `~/.claude/settings.json`:

```json
{
  "env": {
    "SAL_PROJECT_ID": "my-app",
    "SAL_STORAGE_TYPE": "s3",
    "SAL_STORAGE_BUCKET": "my-session-bucket",
    "SAL_STORAGE_REGION": "us-east-1",
    "SAL_STORAGE_ID": "AKIAIOSFODNN7EXAMPLE",
    "SAL_STORAGE_SECRET": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  },
  "enabledPlugins": {
    "claude-session-sync@session-analyzer": true
  }
}
```

#### Option B: Project-local (per-project credentials)

Create `.claude/settings.local.json` in your project root (this file is
gitignored by default, so credentials stay local):

```json
{
  "env": {
    "SAL_PROJECT_ID": "my-app",
    "SAL_STORAGE_TYPE": "s3",
    "SAL_STORAGE_BUCKET": "my-session-bucket",
    "SAL_STORAGE_REGION": "us-east-1",
    "SAL_STORAGE_ID": "AKIAIOSFODNN7EXAMPLE",
    "SAL_STORAGE_SECRET": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "SAL_STORAGE_ENDPOINT": "http://localhost:4566"
  }
}
```

> **Note:** `pluginConfigs` values are only read from user settings
> (`~/.claude/settings.json`), `--settings`, and managed settings — not from
> project or local settings files. However, the `env` key **is** read from all
> settings scopes, so environment variables in `.claude/settings.local.json`
> work correctly for plugin configuration.

#### Option C: Shell environment

Export the variables before launching Claude Code:

```bash
export SAL_PROJECT_ID="my-app"
export SAL_STORAGE_TYPE="s3"
export SAL_STORAGE_BUCKET="my-session-bucket"
export SAL_STORAGE_REGION="us-east-1"
export SAL_STORAGE_ID="AKIAIOSFODNN7EXAMPLE"
export SAL_STORAGE_SECRET="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
claude
```

### Using LocalStack for local development

For local testing without a real AWS account, run
[LocalStack](https://localstack.dev/) and point the plugin at it:

```json
{
  "env": {
    "SAL_PROJECT_ID": "local-dev",
    "SAL_STORAGE_TYPE": "s3",
    "SAL_STORAGE_BUCKET": "sal-sessions",
    "SAL_STORAGE_REGION": "us-east-1",
    "SAL_STORAGE_ENDPOINT": "http://localhost:4566",
    "SAL_STORAGE_ID": "test",
    "SAL_STORAGE_SECRET": "test"
  }
}
```

## Opting out

| Goal                          | Setting                          |
| ----------------------------- | -------------------------------- |
| Disable transcript capture    | `SAL_CAPTURE_TRANSCRIPTS=false`  |
| Fully disable synchronization | `SAL_SYNC_DISABLED=true`         |

When fully disabled, the engine performs no filesystem discovery beyond the
minimum required to determine that synchronization is disabled, and
`SessionStart` does not spawn the watcher.

## Development

```bash
# Build the plugin
pnpm --filter @lucasschirm/claude-session-sync build

# Run tests
pnpm --filter @lucasschirm/claude-session-sync test

# Typecheck
pnpm --filter @lucasschirm/claude-session-sync typecheck

# Lint
pnpm --filter @lucasschirm/claude-session-sync lint
```

### Package structure

```
packages/plugins/claude-session-sync/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── hooks/
│   └── hooks.json           # Lifecycle hook definitions
├── src/
│   ├── claude.ts            # Hook input parsing + Claude session mapping
│   ├── hook.ts              # Generic hook entry (PreCompact/PostCompact/Stop/...)
│   ├── session-start.ts     # SessionStart entry point
│   ├── session-end.ts       # SessionEnd entry point
│   ├── transcript-watcher.ts # Detached watcher spawner
│   └── index.ts             # Public API barrel
├── bin/                     # Built executables (esbuild single-file bundles)
├── build.mjs                # esbuild bundling script
├── tests/
│   ├── unit/                # Unit tests
│   └── e2e/                 # End-to-end plugin lifecycle tests
└── package.json
```

## License

ISC
