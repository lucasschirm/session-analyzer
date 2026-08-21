# AGENTS.md - Source Directory Overview

This document describes all files in the `src` directory for AI agents and developers.

## Directory Structure

```
src/
├── main.ts                        # Application entry point (mounts <app-root>)
├── router.ts                      # Hash-based router built on @lit-labs/router Routes
├── components/
│   ├── metrics-card.ts            # Clickable dashboard metric card; optional valueTitle prop for full-number hover tooltip
│   ├── session-list.ts            # Clickable session rows (date-descending); token count rendered compactly with full-number tooltip
│   ├── events-table.ts            # Drill-down data table for indicator details; metadata column supports hover tooltip and click-to-expand full JSON
│   ├── project-selector.ts        # Project dropdown (input component)
│   ├── project-modal.ts           # New-project modal (name + description)
│   ├── passkey-modal.ts           # Passkey create/unlock modal for the credential vault
│   ├── connect-modal.ts           # S3 connection management modal (list, add, edit, test, sync)
│   ├── upload-zone.ts             # Drag & drop + file picker upload zone
│   └── session-transcript.ts      # Chat-like markdown transcript view; optional renderAfter(message) hook lets a parent interleave content (e.g. inline subagent cards) at a point in the timeline; owns the subagent-card styles since renderAfter's template renders inside this component's shadow root
├── db/
│   ├── database.ts                # DatabaseManager over sqlite3 oo1; extended schema with cache_creation/cache_read tokens, model_usage, tool parameters, and message uuid/parent_uuid; includes migrate() for backward compatibility
│   ├── db-protocol.ts             # Typed main-thread <-> worker message protocol
│   ├── db-worker.ts               # Web Worker hosting SQLite (OPFS when available); enforces strict message ordering via promise queue
│   └── db-client.ts               # Main-thread proxy with promise correlation
├── lib/
│   ├── markdown.ts                # marked + DOMPurify rendering helpers
│   ├── format.ts                  # Compact number formatting (K/M/B) with full-number tooltips; estimateTokenCount/formatEstimatedTokens for the ~4-chars/token tool-result estimate (no exact tokenizer available client-side)
│   └── claude-to-dashboard.ts     # toDashboardSession(native, projectId, title): transforms a `@lucasschirm/sal-claude-session-parser` ClaudeCodeSession into DashboardSession - token accumulation incl. per-model, tool_use/tool_result pairing by id, result_uuid capture, isMeta filtering, compact_boundary -> compactions, task_reminder -> SessionTask, ai-title -> title. Successor to the old inline parseClaudeCode; reuses SessionBuilder from workers/session-builder.ts
├── pages/
│   ├── app-root.ts                # Root shell: header, HashRouter outlet, DB bootstrap, sync manager init, and Connect entry point
│   ├── home-page.ts               # Projects CRUD grid + export database
│   ├── project-view.ts            # Upload zone + search + sessions for one project; Total Tokens card uses compact number formatting with tooltip
│   ├── session-dashboard.ts       # Metric cards + link to the Session Transcript page; "Total Tokens" card = input+output only (cache tokens excluded - see SessionBuilder.finalize); enriched with token breakdown panel (input/output/cache write/cache read), an estimated Tool Result Tokens panel (~4-chars/token heuristic over tool_result content, % of total input volume), models-used table, top-tools ranked list (Skill/Agent tool calls excluded - see isSkillTool/isAgentTool), skills-used list with parameters, a collapsible Subagents panel ("Show all"), and separate Agents/Skills metric cards (Agent/Skill tool invocation counts, distinct from Sub Agents)
│   ├── indicator-details.ts       # Granular events table per indicator; 'turns' renders messages as a collapsible parent/child tree nested by uuid/parent_uuid; 'tools' excludes Skill/Agent tool calls (their own indicators below); 'skills' and 'agents' each list their tool's invocations (filters, Inputs/Result detail, plus a "Linked Content" section recovered by matching a message's parent_uuid against the invocation's tool_result uuid - ToolExecution.result_uuid); 'diagnostics' for cache miss tracking
│   └── session-transcript-page.ts # Dedicated transcript page: main session's transcript as a single full-width column by default. Subagent cards render inline in the main transcript (via session-transcript's renderAfter hook), placed after the message closest to each subagent's started_at - a chronological best-effort placement, since there's no exact tool_use <-> subagent-transcript link in the data. At most one subagent column is open at a time, driven by the `:agentId` route segment; opening/closing is plain navigation (`<a href="#/sessions/:id/transcript/:agentId">`), not local toggle state
├── types/
│   └── index.ts                   # Centralized TypeScript type definitions; new types: ModelTokenUsage, updated DashboardSession (added cache_creation_tokens/cache_read_tokens/models), ToolExecution (added parameters, result_uuid - the tool_result entry's own uuid, used to locate follow-up content via parent_uuid), TranscriptMessage (added uuid/parent_uuid), SessionMetrics (added cache/total token fields), IndicatorKey (added 'diagnostics', 'skills'), SubagentUsage (added optional messages: TranscriptMessage[] for the subagent's own transcript)
└── workers/
    ├── session-parser.worker.ts   # Format detection + 6 format parsers. Claude Code detection/parsing now delegates to `@lucasschirm/sal-claude-session-parser` (detectClaudeCode + parseSessionTranscript) followed by lib/claude-to-dashboard.ts's toDashboardSession, in place of the old inline parseClaudeCode; the other five formats (Agentic Pi, Antigravity, OpenCode/Codex, MCP, Local Runner) still parse directly into DashboardSession here via SessionBuilder. Re-exports isSkillTool/isAgentTool/isReadTool/isWriteTool/isAgentOrSkill from session-builder.ts for existing importers (exact 'Skill'/'Agent' tool name match - see root AGENTS.md's Domain Terminology)
    ├── session-builder.ts         # SessionBuilder class + generateId + isReadTool/isWriteTool/isAgentOrSkill/isSkillTool/isAgentTool - extracted out of session-parser.worker.ts so lib/claude-to-dashboard.ts can reuse it without pulling in the other five formats' parsing code; behaviour unchanged from before the extraction
    └── parser-client.ts           # Spawns the parser worker per file
```

## Routing

Routes are hash-based (`#/...`) for GitHub Pages compatibility:

- `#/` — Home page (projects list + CRUD)
- `#/projects/:projectId` — Project view (upload + search + sessions)
- `#/sessions/:sessionId` — Session dashboard (metrics; links out to the transcript page)
- `#/sessions/:sessionId/indicator/:indicator` — Indicator details drill-down (`tokens`, `compactions`, `turns`, `tools`, `files_read`, `files_written`, `agents`, `skills`, `diagnostics`, `tasks`)
- `#/sessions/:sessionId/transcript` — Session transcript page, single full-width column
- `#/sessions/:sessionId/transcript/:agentId` — Session transcript page, split with that subagent's column open

## Notes for Agents

- All TypeScript code should follow the project's coding standards (strict mode, no `any`, ES modules).
- Type definitions in `types/index.ts` should be used instead of inline types when possible.
- Web Workers handle CPU-intensive work: parsing (`session-parser.worker.ts`) and all SQLite transactions (`db-worker.ts`).
- Database access goes through `db/db-client.ts` (main thread) or `db/database.ts` (inside the worker) — never touch SQL elsewhere.
- SQL must stay parameterized; never interpolate values into query strings.
- Lit components follow one-component-per-file with kebab-case filenames matching the tag name.
