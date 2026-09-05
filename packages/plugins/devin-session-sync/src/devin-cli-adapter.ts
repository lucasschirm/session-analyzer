import path from 'node:path';

import type { CliConfigPaths, CliHarnessAdapter } from '@lucasschirm/sal-sync';

import { DevinHarnessProfile } from './devin-profile.js';

const HELP_TEXT = `devin-sync — manually sync Devin CLI sessions to S3 storage

Usage:
  devin-sync <command> [options]

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
  DEVIN_SYNC_LOG_PATH_FOLDER               Folder for error log files written when a
                                          command aborts (optional, defaults to
                                          $SAL_DATA_DIR/logs, i.e. ~/.sal-sync/logs)

Configuration is resolved in precedence order (highest first):
  1. process.env                           (real environment variables)
  2. .devin/config.local.json "env"        (project-local, expected gitignored)
  3. .devin/config.json "env"              (project, may be committed)
  4. ~/.config/devin/config.json "env"     (user-global, may be committed)

Security: SAL_STORAGE_ENDPOINT, SAL_STORAGE_ACCESS_KEY_ID, and
SAL_STORAGE_SECRET_ACCESS_KEY are only read from process.env or
.devin/config.local.json — never from a file that might be committed to git.
`;

function resolveDevinConfigPaths(cwd: string, homedir: string): CliConfigPaths {
  return {
    local: path.join(cwd, '.devin', 'config.local.json'),
    project: path.join(cwd, '.devin', 'config.json'),
    userGlobal: path.join(homedir, '.config', 'devin', 'config.json'),
  };
}

/**
 * Concrete `CliHarnessAdapter` for Devin, mirroring `ClaudeCliAdapter`
 * (`packages/plugins/claude-session-sync/src/claude-cli-adapter.ts`) — see
 * that module's doc comment for why the two plugins' adapters live in their
 * own plugin packages rather than `sync`/`sync-core`.
 *
 * Unlike `ClaudeCliAdapter.migrateManifestHarness` (a literal, deliberately
 * NOT `profile.harness` — see that adapter's doc comment for why), this
 * adapter's `migrateManifestHarness` correctly IS
 * `DevinHarnessProfile.harness` (`'devin'`): Devin has no legacy
 * `classifyManifestArtifact` string-literal mismatch to work around, so it
 * follows the DS-B5 #143 pattern of always sourcing `harness` from the
 * profile, never a hardcoded string. Do not "clean up" this asymmetry by
 * unifying the two adapters' sourcing — they are correct as different.
 */
export const DevinCliAdapter: CliHarnessAdapter = {
  profile: DevinHarnessProfile,
  binName: 'devin-sync',
  packageName: '@lucasschirm/devin-session-sync',
  logFolderEnvVar: 'DEVIN_SYNC_LOG_PATH_FOLDER',
  resolveConfigPaths: resolveDevinConfigPaths,
  localConfigDisplayPath: '.devin/config.local.json',
  migrateManifestHarness: DevinHarnessProfile.harness,
  helpText: HELP_TEXT,
};
