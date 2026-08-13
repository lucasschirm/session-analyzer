# @lucasschirm/sal-claude-session-parser

A pure, dependency-free parser for Claude Code's on-disk formats: session
transcripts (`~/.claude/projects/*/*.jsonl`), subagent transcripts and meta
files, and the `.claude` configuration surface (`settings.json`,
`.mcp.json`, agent/skill/rule definition files, plugin marketplaces).

It parses text the caller supplies — it never touches a filesystem — so it
runs anywhere JavaScript does, including inside the `site` app's browser Web
Worker.

## Hard constraints

- **Zero runtime dependencies.** Everything, including YAML frontmatter
  reading, is hand-rolled.
- **No `fs`/`path`/`process`/`Buffer`, no DOM.** The package's `tsconfig.json`
  sets `types: []` so Node globals don't even typecheck; only plain
  ECMAScript is used.
- **Never throws.** Every `parseX` function returns a typed result;
  malformed input is recorded in a `parseErrors: ParseError[]` array
  instead of raising an exception. A single bad JSONL line never aborts a
  parse.
- **Pure.** No I/O, no globals, no mutation of inputs.

## Usage

```ts
import { parseSession, parseMcp, parseSettings, buildConfigSnapshot } from '@lucasschirm/sal-claude-session-parser';

// Parse a session transcript and fold in already-parsed config pieces.
const session = parseSession(transcriptJsonl)
  .appendMcp(parseMcp(mcpJson))
  .appendSettings(parseSettings(settingsJson, 'project'))
  .toSession();

// Or bucket config files with no transcript at all.
const snapshot = buildConfigSnapshot([
  parseSettings(settingsJson, 'user'),
  parseMcp(mcpJson),
]);
```

## Design spec

The full design — every type, field, and resolved decision — lives at
[`docs/superpowers/specs/2026-08-12-claude-session-parser-design.md`](../../../docs/superpowers/specs/2026-08-12-claude-session-parser-design.md).
