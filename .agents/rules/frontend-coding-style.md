---
globs: "packages/site/src/**/*.ts"
---

# Coding Style

**When to use this rule:**

- When creating or editing Lit web components (`.ts`) and reactive controllers/services/utilities used by Lit elements.

## Mandatory performance review (`lit-performance-optimizer` agent)

Whenever you **create or change** any frontend file under `packages/site/src/`
(components, controllers, stores, services, or other `.ts` code), dispatch
the `lit-performance-optimizer` agent to validate the change once the edit is
complete:


```

Agent({
subagent_type: "lit-performance-optimizer",
description: "Review frontend perf",
prompt: "Review the frontend files I just created/changed for runtime
performance, lit-html render cycle efficiency, shadow DOM scoping, bundle size, and maintainability:
"
})

```

Guidelines:

- **Scope the review to the files you actually touched** — pass the concrete
  paths in the prompt rather than asking for a whole-repo sweep.
- **Batch the review** — run the agent once after a logical chunk of frontend
  work is finished (component done, controller extracted), not after every
  intermediate `Edit`. Reviewing half-written code wastes the pass.
- **Act on the findings** — apply the agent's recommendations (or note why a
  finding is intentionally not addressed) before considering the task complete.
- This complements, and does not replace, the mandatory `pnpm verify`
  (typecheck + Biome + tests) gate in `.agents/rules/workspace-rules.md`.

## Lit component conventions (Priority A/B)

- Custom element tag names must be multi-word and contain a hyphen (e.g., `my-element`).
- Keep one component per file.
- Component filenames must be consistent and use `kebab-case` matching the element tag name (e.g., `my-element.ts`).
- Component class names must use `PascalCase` (e.g., `MyElement`).
- Child components tightly coupled to a parent must be prefixed with the parent name.
- Prefer full words in component names; avoid uncommon abbreviations.

## Properties, events, and templates

- Properties must be declared with explicit types using the `@property({ type: Type })` decorator.
- Use strictly typed properties and internal state with `@state()` (avoid `any`).
- Always use the `repeat()` directive from `lit/directives/repeat.js` with a unique `key` function when rendering dynamic lists.
- Never mix list rendering and conditional logic in the same mapping function without clear separation. Use `when()` or ternary operators `? :` for conditionals.
- Templates (`render()` methods) must contain only simple expressions; move complex logic to getter methods or dedicated helper functions.

## Template formatting consistency

- Elements/components with multiple attributes or bindings must be split across multiple lines, one per line.
- Use consistent attribute/binding ordering in the `html` template literal:
  - boolean attributes (`?disabled=${...}`)
  - DOM properties (`.value=${...}`)
  - standard attributes (`class="..."`)
  - unique identifiers (`id`, `slot`)
  - event listeners (`@click=${...}`)
  - content

## Class structure and styles

- Keep Lit class members in a consistent order:
  1. `static styles` (using the `css` tag)
  2. `static properties` (if not using decorators)
  3. `@property()` and `@state()` declarations
  4. `constructor()` and lifecycle methods (`connectedCallback`, `updated`, etc.)
  5. Getters/Setters
  6. Event handlers
  7. `render()` method
- Styles must be defined within the `static styles` block to ensure they are properly scoped to the Shadow DOM.

---

# Managing Components

## Root class and host naming

- Styles applied to the root of the component must utilize the `:host` selector within the `static styles` block.
- If an internal wrapper `<div>` or `<section>` is required inside the shadow DOM, it must include a CSS class identical to the custom element's tag name in `kebab-case`.
- Example:
  - Component class: `MetricsCard`
  - Tag name: `metrics-card`
  - Internal wrapper (if used): `<div class="metrics-card">...</div>`

---

# Input Components

**When to use:** When creating or editing any form or input-based Lit component.

## Rules

- If you are not sure if the component being created is an input component, ask the user.
- Lit uses one-way data flow. Always use a specific property (e.g., `@property() value`) to handle input data.
- Always dispatch a `CustomEvent` (e.g., `new CustomEvent('value-changed', { detail: newValue })`) to handle output data. Do not mutate passed object properties directly.
- Components that receive an object as input should bind that object to a dedicated property and dispatch the entire updated object in the event payload.
- Components that receive an array as input should emit the updated array or specific selected object(s) as the value on the event detail.
- If a component receives an array of objects as input, and allows multiple selection, it should always emit an array of the selected objects via the custom event.