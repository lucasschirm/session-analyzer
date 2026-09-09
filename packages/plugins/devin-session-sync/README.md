# @lucasschirm/devin-session-sync

A [Devin CLI](https://docs.devin.ai/) plugin that synchronizes your session data
— the local `sessions.db` transcript and telemetry — to S3-compatible storage
via the [`@lucasschirm/sal-sync`](../../sync) engine.

## Installation

Devin plugins are installed at the user level and are available across all your
projects. There is no `marketplace.json` for Devin plugins — installation is
direct from a git source subdirectory or a local folder.

### Prerequisites

- **Devin CLI** installed and on your `PATH` (`devin --version`).
- **Node.js >= 22.13.0** (or >= 23.4.0) — the plugin reads Devin's local
  `sessions.db` via the built-in `node:sqlite` module, which requires one of
  these versions.
- **S3-compatible storage** configured (see [Configuration](#configuration)
  below).

### From the remote repository

Use the `owner/repo#path` shorthand to install from the subdirectory:

```bash
devin plugins install lucasschirm/session-analyzer#packages/plugins/devin-session-sync
```

Add `--local` to install it only for the current project, or `-y` to skip
confirmations:

```bash
devin plugins install lucasschirm/session-analyzer#packages/plugins/devin-session-sync --local -y
```

### Pinning a version

Pin to a specific commit `sha`:

```bash
devin plugins install lucasschirm/session-analyzer#packages/plugins/devin-session-sync --sha=<commit-sha>
```

Or pin to a branch or tag `ref`:

```bash
devin plugins install lucasschirm/session-analyzer#packages/plugins/devin-session-sync --ref=main
```

Use **either** `--sha` or `--ref`, not both.

### From a local clone (for development)

Build the plugin bundle first, then install from the local path:

```bash
pnpm --filter @lucasschirm/devin-session-sync build
devin plugins install ./packages/plugins/devin-session-sync
```

The build produces self-contained executables in `bin/` (no `node_modules`
required at runtime):

```
bin/session-start        # SessionStart hook entry point
bin/session-end          # SessionEnd hook entry point
bin/hook                 # Generic hook entry
bin/watcher              # Watermark / state watcher
bin/devin-sync           # Standalone CLI for manual sync/list/download
```

### Verifying the installation

```bash
devin plugins list
devin plugins info devin-session-sync
```

### Updating and removing

```bash
devin plugins update devin-session-sync   # re-fetch at the latest version
devin plugins remove devin-session-sync    # uninstall
```

## Configuration

The plugin and its standalone CLI read configuration from environment variables,
falling back to `.devin/config.local.json` and `.devin/config.json` `env` keys.
Required variables:

| Variable                    | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `SAL_PROJECT_ID`            | Unique project identifier.                       |
| `SAL_STORAGE_TYPE`          | Storage backend (`s3` only today).               |
| `SAL_STORAGE_BUCKET`        | S3 bucket name.                                  |
| `SAL_STORAGE_REGION`        | AWS region.                                      |
| `SAL_STORAGE_ACCESS_KEY_ID` | AWS access key ID.                               |
| `SAL_STORAGE_SECRET_ACCESS_KEY` | AWS secret access key.                       |

See the sync engine documentation for the full option list and LocalStack
configuration.

## What it does

The Devin CLI maintains a local SQLite database at
`~/.local/share/devin/cli/sessions.db` (or `$XDG_DATA_HOME/devin/cli/sessions.db`).
This plugin reads that database and produces deterministic, ordered
`devin-session-jsonl/v1` output, then uploads it through the SAL sync engine so
the [Agentic Sessions Dashboard](../../../) can analyze it alongside Claude Code
and other agentic session sources.

### Plugin lifecycle

The plugin is driven by the Devin CLI hook system (declared in
[`hooks.json`](hooks.json)):

| Event          | What happens                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| `SessionStart` | Records the session and starts the `watcher` to observe incremental state.    |
| `Stop`         | Syncs the current session state (fires every turn, works in both Cloud and local). |
| `PostCompaction` | Syncs after context compaction.                                             |
| `SessionEnd`   | Performs the final sync: flushes remaining state, uploads the manifest, and ends cleanly. |

The `watcher` also keeps a watermark so repeated runs are incremental and do not
transmit data that has already been synced.

### Unattended sessions (Cloud)

Devin Cloud sessions never fire `SessionStart`/`SessionEnd` hooks. To cover
that, the plugin ships a mandatory `bin/watcher` daemon that polls
`sessions.db` watermarks on an interval and re-syncs changed sessions. Start it
independently of any hook (e.g. via a process manager or a login shell):

```bash
node ./packages/plugins/devin-session-sync/bin/watcher
```

The bulk `devin-sync sync` CLI command (below) is the manual/scheduled
catch-up path for the same gap.

## Standalone CLI

In addition to the Devin CLI hooks, this package ships a standalone CLI
(`devin-sync`) for manually uploading, listing, and downloading sessions from
S3 storage. It is useful for backfilling historical sessions, inspecting what
has been synced, or restoring data to a new machine.

### Installation

The CLI is included in the same npm package. You can run it via `npx` without
installing anything:

```bash
npx @lucasschirm/devin-session-sync -v
```

Or install it globally for shorter commands:

```bash
npm install -g @lucasschirm/devin-session-sync
devin-sync -v
```

### Commands

```
devin-sync sync                    # Upload all local sessions to S3
devin-sync sync --force            # Re-upload all sessions, ignoring local state
devin-sync list                    # List all projects in storage
devin-sync list --current          # List sessions for the current project
devin-sync list <project-id>       # List sessions for a project
devin-sync download --session-id=<id> --output=<dir>
devin-sync download all --output=<dir>
devin-sync remove <project-id>     # Dry run: list what would be removed
devin-sync remove <project-id> --yes
devin-sync migrate                 # Dry run: list old-format keys and missing manifests
```

Run `devin-sync --help` for the full command reference.

## Distribution note

- The Claude plugin is listed in the repository's
  [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json);
  that file intentionally contains only the Claude plugin.
- Devin's plugin installer does not consume a `marketplace.json` file. The devin
  plugin is distributed **only** via direct git-subdir install:
  `devin plugins install lucasschirm/session-analyzer#packages/plugins/devin-session-sync`.
  There is no devin `marketplace.json` equivalent, and adding one would not be
  consumed by the installer.

## Publishing

This package is auto-published by `.github/workflows/version-patch.yml` on every
push to `main`, alongside the Claude plugin. It shares the same esbuild-bundled,
provenance-enabled, public npm publish path. Both plugins are kept at the same
version (aligned and bumped together by the version-patch workflow).

## Development

```bash
# Build the plugin
pnpm --filter @lucasschirm/devin-session-sync build

# Run tests
pnpm --filter @lucasschirm/devin-session-sync test

# Typecheck
pnpm --filter @lucasschirm/devin-session-sync typecheck

# Lint
pnpm --filter @lucasschirm/devin-session-sync lint
```

## License

ISC
