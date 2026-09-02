# Packages

 - All packages should have a "verify" script in their package.json
 - The "verify" script should run all tests and checks for the package
 - The "verify" script should run linting and type checking
 - The "verify" script should be run before committing changes
 - The "verify" script should be run in the root of the workspace in parallel

# Coding
 - Every function should be kept with the maximum 20 lines of code with a hardcap of 30 lines.

# Testing
 - All packages should keep the test coverage above 80% at all time.
 - Plan all tests before implemeting. The test should cover business requirements and no only code coverage.
 - Never assume your fixes worked. When possible always validate it locally.

# Linting
 - Aways fix any linting errors. Related or not to the current session.
 - Do not use @ts-ignore or @ts-expect-error.
 - Biome should be a workspace dependency.
 - All packages should use Biome for linting and formatting.
 - Biome configuration should be shared across all packages.
 - Each package can have its own Biome configuration, but it should extend the workspace configuration.

# Versioning

- Every package in the workspace must define a `version:patch` script in its package.json.
- The `version:patch` script must be a no-op (`"version:patch": "exit 0"`) unless the package is explicitly designated as the active version-bumping package.
- When a package is designated for version bumps, its `version:patch` script must run `npm version patch` (with `--no-git-tag-version` in CI to avoid creating tags).
- New packages must add the `version:patch` script before their first merge to `develop`.

# Working on Issues

- When starting work on a GitHub issue, the agent is responsible for marking it in progress and linking its branch to the issue:
  - Add the "In Progress" label: `gh issue edit <number> --add-label "In Progress"`.
  - Associate the working branch with the issue so the merge automatically closes it:
    - New branch: `gh issue develop <number> --name <branch-name> --base main` (creates the branch already linked to the issue).
    - Existing branch: link it via the GraphQL `createLinkedBranch` mutation, or ensure the PR body contains a closing keyword (`Closes #<number>`).
  - The PR for the branch must always include `Closes #<number>` as a fallback, so merging closes the issue even if the branch link is missing.
- One issue per branch: do not mix work for multiple issues on the same branch.
- If the issue has a parent issue of type "Feature" (a parent sub-issue relationship where the parent carries the `feature` label), the pull request must target the branch associated with that Feature issue instead of `main`:
  - Find the parent via the issue's sub-issue relationship (`gh api graphql` `parent` field) and look up the parent's linked branch (its Development section / `linkedBranches`).
  - If the Feature issue has no associated branch yet, create and link one first (`gh issue develop <feature-number> --name <feature-branch> --base main`), then open the sub-issue's PR with `--base <feature-branch>`.
  - Only the Feature branch's own PR targets `main`; merging it closes the Feature issue after all sub-issue PRs have merged into it.
- If work on the issue stops without a merge (abandoned or blocked), remove the "In Progress" label and comment on the issue with the reason.

# Before completing any task
 - Aways run "pnpm verify" from the workspace root directory and fix any test or linting errors.