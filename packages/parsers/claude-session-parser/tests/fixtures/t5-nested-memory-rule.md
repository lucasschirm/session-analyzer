---
description: When a component in packages/renderer/src/widgets changes, regenerate the widget catalog so packages/example-renderer reflects it
paths:
  - "packages/renderer/src/widgets/**"
---

# Widget Catalog Sync

Widgets in `packages/renderer/src/widgets` are the source of truth for the widget
catalog that `packages/example-renderer` consumes. Any change to a widget's public
props MUST be reflected there in the same change:

- Regenerate the catalog: run `npm run build:widgets` in `packages/renderer`.
- Commit the regenerated `schemas/widget-catalog.json` alongside the widget change.
- Never hand-edit `widget-catalog.json` — it is generated output, not source.
