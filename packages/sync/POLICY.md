# Privacy and Data Retention Policy

This document describes what the `@lucasschirm/sal-sync` engine captures, how
it is sanitized, where it is retained, and how to opt out or disable the
system entirely. It is the human-readable counterpart to the typed policy
contracts exported by the package (see `src/privacy.ts`).

## What is captured

The sync engine captures only the artifacts listed in the versioned capture
allowlist (`src/allowlist.ts`):

- Session and subagent transcript JSONL files.
- Workspace `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/agents/**`, `.claude/skills/**`,
  `.claude/rules/**`.
- Global `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
  `~/.claude/agents/**`, and `~/.claude.json`.

It also captures the session telemetry model: `sessionId`, `projectId`,
`harness`, `harnessVersion`, `model`, `startedAt`, `endedAt`, `durationMs`,
and `endReason`.

## What is sanitized

Configuration artifacts (workspace/global settings, CLAUDE.md, .mcp.json,
agents, skills, rules) are passed through the recursive JSON sanitizer using
the versioned field list and string patterns in `src/sanitization.ts`.

The sanitizer redacts known sensitive fields (`env`, `password`, `secret`,
`token`, `accessToken`, `refreshToken`, `apiKey`, `privateKey`,
`authorization`, `credential`, `credentials`, and variants) and applies
targeted string redaction patterns for bearer tokens, credential-bearing URLs,
and private-key blocks.

MCP configuration (`.mcp.json` and `~/.claude.json`) is treated as high-risk
and uses the separate MCP redaction rules in `src/sanitization.ts`.

## Transcripts

Session and subagent transcript JSONL files are captured **raw by default**.
They are not sanitized; they are only subject to size limits
(`SAL_MAX_TRANSCRIPT_BYTES`, `SAL_MAX_JSONL_LINE_BYTES`).

To opt out of transcript capture, set:

```text
SAL_CAPTURE_TRANSCRIPTS=false
```

When transcripts are disabled, the `FileChanged` watcher is not spawned,
transcript artifacts are excluded from every upload, and the manifest records
`transcriptsCaptured: false`.

## MCP and global configuration capture

MCP configuration is captured because it is part of the documented workspace
and global configuration surface. It is also sanitized before upload.

Global Claude Code configuration (`~/.claude/...`) and `~/.claude.json` are
captured and sanitized under the same rules as workspace configuration.

## Remote and local retention

- **Remote** artifacts are stored in the user-configured S3-compatible
  destination. Retention and deletion are controlled by the user and the
  storage provider; this package does not expire remote objects
  automatically.
- **Local** durable state is kept under the persistent plugin-data directory.
  It survives process crashes and is used to compute deltas between hook
  invocations.

## Deletion

Deleting a session's remote data and local state is a **manual** operation.
Neither the sync engine nor the plugin removes data automatically when a
session ends.

## Opt-out and full disable

- Opt out of transcript capture: `SAL_CAPTURE_TRANSCRIPTS=false`.
- Fully disable synchronization: `SAL_SYNC_DISABLED=true`.

When fully disabled, the engine performs no filesystem discovery beyond the
minimum required to determine that synchronization is disabled, and
`SessionStart` does not spawn the watcher.
