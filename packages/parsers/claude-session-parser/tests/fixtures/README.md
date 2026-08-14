# Fixture policy — read before adding or editing any fixture here

This repository is **PUBLIC**. Every fixture in this directory (and any new
fixture added by future test work) must be **fully synthetic**:

- Invented project names, paths, and repo names
  (e.g. `/home/testuser/projects/orbit-tracker`, `demo-org/orbit-tracker`).
- Invented agent/skill/rule/MCP/marketplace/plugin names
  (e.g. agent `docs-drafter`, skill `csv-wrangler`, MCP server `zephyr:tools`,
  marketplace `nimbus-market`).
- Invented prose for prompts, descriptions, hook output, PR titles, and any
  other free text.
- Real Claude Code **field names and structural shapes** (`uuid`,
  `parentUuid`, `attachment.type: 'deferred_tools_delta'`, `mcp__ns__tool`,
  etc.) are the product's schema and are fine to use verbatim. Real
  **values** copied from any real session or config are not.
- Never copy-paste from a real transcript and "clean it up" — author
  fixtures from scratch against the TypeScript types in `src/types/`.

This constraint exists because real content from a private `~/.claude`
corpus (real project names, agent/skill names, MCP server names, task
prose) has previously leaked into public fixtures when anonymization was
done too narrowly. Treat every fixture file added to this directory as
something that will be read by the public, forever, in the git history —
not just its latest revision.
