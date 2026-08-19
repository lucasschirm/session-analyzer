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

# Before completing any task
 - Aways run "pnpm verify" from the workspace root directory and fix any test or linting errors.