# packages/parsers/devin-session-parser/

Pure, dependency-free Devin CLI session parser for the Session Analyzer platform.

Package name: `@lucasschirm/sal-devin-session-parser`

This package contains pure parsing functions for `devin-session-jsonl/v1` lines
(`session`, `message`, `tool_call`, `prompt`), ATIF v1.7 transcripts,
`models.json`, and `schema-descriptor.json`. It has zero runtime dependencies,
no I/O side effects, and never depends on any database or sync plugin.

## Source layout

```
src/
├── index.ts               # Public barrel export
├── jsonl/
│   ├── types.ts           # DevinJsonlLine, DevinMessageLine, DevinSessionLine, etc.
│   ├── parse-line.ts      # Line parser for devin-session-jsonl/v1
│   └── compaction.ts      # Compaction boundary anchor detection
├── tool-call/
│   └── acp-parse.ts       # ACP tool_call_json and tool_call_update_json parsing
├── message/
│   └── role-map.ts        # Devin role mapping (user, assistant, tool, system)
├── models/
│   └── parse.ts           # models.json model catalog parser
├── atif/
│   └── parse.ts           # ATIF v1.7 transcript parser
└── schema-descriptor/
    └── parse.ts           # schema-descriptor.json parser
```

## Key invariants

- **Zero dependencies & pure**: No external runtime libraries, no I/O, no network.
- **Never throws on single line error**: Malformed JSON or invalid schema records
  a structured warning and skips the line without aborting parsing.
- **Embedded tool call extraction**: OpenAI-style `chat_message.tool_calls` and
  `chat_message.tool_call_id` on `message` lines are parsed and typed so downstream
  transformers can extract subagent tool invocations and results without reparsing JSON.
- **Model generation metrics**: Embedded generation model and token/latency metrics
  under `chat_message.metadata` are parsed and typed on message lines.

## Key relationships

- Imported by `@lucasschirm/sal-devin-transformer` for parsing Devin artifacts.
- Never imports `@lucasschirm/sal-db-core`, `@lucasschirm/sal-db`, `@lucasschirm/sal-sync`,
  or any plugin package.
