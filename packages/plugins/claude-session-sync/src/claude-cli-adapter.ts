import path from 'node:path';

import type { CliConfigPaths, CliHarnessAdapter } from '@lucasschirm/sal-sync';

import { ClaudeHarnessProfile } from './claude-profile.js';

const HELP_TEXT = `claude-sync — manually sync Claude Code sessions to S3 storage

Usage:
  claude-sync <command> [options]

Commands:
  sync                                    Upload all local sessions to S3
  sync --force                            Re-upload all sessions, ignoring local state
  list                                    List all projects in storage
  list --current                          List sessions for the current project (SAL_PROJECT_ID)
  list <project-id>                       List sessions for a project
  list <project-id> --session=<session-id>
                                          List files in a session
  list <project-id> --session=<session-id> --path=<path>
                                          List files under a session sub-path
  download --session-id=<id> --output=<dir>
                                          Download a specific session
  download all --output=<dir>             Download all sessions for this project
  remove <project-id>                     Dry run: list what would be removed for a project
  remove <project-id> --yes               Remove all objects for a project (never touches
                                          shared global/cas/ content-addressed files)
  remove <project-id> --session=<id> --yes
                                          Remove all objects for a single session
  migrate                                Dry run: list old-format keys and missing manifests
  migrate --project=<project-id>         Dry run for a specific project
  migrate --yes                          Copy old keys to new format + generate missing manifests
  migrate --yes --manifests              Only generate missing manifests (skip key migration)
  migrate --yes --delete-old             Copy and warn about old keys to delete manually

Options:
  -v, --version                           Print version and exit
  -h, --help                              Print this help and exit

Environment:
  SAL_PROJECT_ID                          Project identifier (required only for --current)
  SAL_STORAGE_TYPE                        Storage backend (required, currently "s3")
  SAL_STORAGE_BUCKET                      S3 bucket name (required)
  SAL_STORAGE_REGION                      AWS region (required)
  SAL_STORAGE_ACCESS_KEY_ID               AWS access key ID (required)
  SAL_STORAGE_SECRET_ACCESS_KEY           AWS secret access key (required)
  SAL_STORAGE_ENDPOINT                    Custom S3 endpoint (optional)
  CLAUDE_SYNC_LOG_PATH_FOLDER             Folder for error log files written when a
                                          command aborts (optional, defaults to
                                          $SAL_DATA_DIR/logs, i.e. ~/.sal-sync/logs)

Configuration is resolved in precedence order (highest first):
  1. process.env                          (real environment variables)
  2. .claude/settings.local.json "env"    (project-local, gitignored)
  3. .claude/settings.json "env"          (project, committed)
  4. ~/.claude/settings.json "env"        (user-global, committed)

Security: SAL_STORAGE_ENDPOINT, SAL_STORAGE_ACCESS_KEY_ID, and
SAL_STORAGE_SECRET_ACCESS_KEY are only read from process.env or
.claude/settings.local.json — never from committed settings files.
`;

function resolveClaudeConfigPaths(cwd: string, homedir: string): CliConfigPaths {
  return {
    local: path.join(cwd, '.claude', 'settings.local.json'),
    project: path.join(cwd, '.claude', 'settings.json'),
    userGlobal: path.join(homedir, '.claude', 'settings.json'),
  };
}

/**
 * Concrete `CliHarnessAdapter` for Claude Code, threaded into the shared
 * `@lucasschirm/sal-sync` CLI (env resolution, config validation, logging,
 * and the remove/download/list/migrate commands) by this plugin's thin
 * `src/cli/*.ts` wrappers.
 *
 * `migrateManifestHarness` is `'claude-code'` — a literal, NOT
 * `ClaudeHarnessProfile.harness` (`'claude'`). This is required, not a bug:
 * `packages/db/src/configuration.ts`'s `classifyManifestArtifact` does an
 * exact string match on the literal `'claude-code'` to run Claude-specific
 * artifact classification (`.agents/rules/manifest-backed-classification.md`).
 * Changing this to `ClaudeHarnessProfile.harness` would silently degrade
 * every session `migrate --manifests` backfills to `unclassified`. See
 * `packages/db/tests/unit/configuration.test.ts` (or equivalent) and
 * `migrate-command.test.ts`'s `migrateManifestHarness` assertion for the
 * regression this must never reintroduce.
 */
export const ClaudeCliAdapter: CliHarnessAdapter = {
  profile: ClaudeHarnessProfile,
  binName: 'claude-sync',
  packageName: '@lucasschirm/claude-session-sync',
  logFolderEnvVar: 'CLAUDE_SYNC_LOG_PATH_FOLDER',
  resolveConfigPaths: resolveClaudeConfigPaths,
  localConfigDisplayPath: '.claude/settings.local.json',
  migrateManifestHarness: 'claude-code',
  helpText: HELP_TEXT,
};
