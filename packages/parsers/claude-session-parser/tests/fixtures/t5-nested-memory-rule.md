---
description: When a step in projects/robot/src/steps changes, regenerate the step catalog so projects/stair-builder reflects it
paths:
  - "projects/robot/src/steps/**"
---

# Step Catalog Sync

Steps in `projects/robot/src/steps` are the source of truth for the step catalog that
`projects/stair-builder` consumes. Any change to a step here MUST be propagated to
stair-builder in the same change:

- Regenerate the catalog: run `npm run build:catalog` in `projects/robot`.
- Commit the regenerated `schemas/step-catalog.json` alongside the step change.
- Never hand-edit `step-catalog.json` — always regenerate it.
