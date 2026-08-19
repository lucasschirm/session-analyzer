import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runDownloadCommand } from './cli/download-command.js';
import { runListCommand } from './cli/list-command.js';
import { runSyncCommand } from './cli/sync-command.js';

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

Configuration is read from process.env, falling back to .claude/settings.local.json "env".
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
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stderr.write(HELP_TEXT);
      return 1;
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`claude-sync: ${message}\n`);
      process.exit(1);
    },
  );
}
