import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runDownloadCommand } from './cli/download-command.js';
import { runListCommand } from './cli/list-command.js';
import { formatAbortMessage, writeErrorLog } from './cli/logger.js';
import { runMigrateCommand } from './cli/migrate-command.js';
import { runRemoveCommand } from './cli/remove-command.js';
import { runSyncCommand } from './cli/sync-command.js';
import { isMainModule } from './is-main-module.js';

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

function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  switch (command) {
    case 'sync':
      return runSyncCommand({ force: rest.includes('--force') || rest.includes('-f') });
    case 'list':
      return runListCommand(rest);
    case 'download':
      return runDownloadCommand(rest);
    case 'remove':
      return runRemoveCommand(rest);
    case 'migrate':
      return runMigrateCommand(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stderr.write(HELP_TEXT);
      return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    async (err) => {
      // An unhandled exception aborted the command. Write a timestamped error
      // log file (with the full stack trace and any chained causes) so the
      // user can diagnose the failure, then point them at it from stderr.
      const command = process.argv.slice(2)[0];
      const result = await writeErrorLog(process.env, command, err);
      process.stderr.write(`${formatAbortMessage(err, result)}\n`);
      process.exit(1);
    },
  );
}
