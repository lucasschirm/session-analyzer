# Packages

 - All packages should have a "verify" script in their package.json
 - The "verify" script should run all tests and checks for the package
 - The "verify" script should run linting and type checking
 - The "verify" script should be run before committing changes
 - The "verify" script should be run in the root of the workspace in parallel

# Linting

 - Biome should be a workspace dependency
 - All packages should use Biome for linting and formatting
 - Biome configuration should be shared across all packages
 - Each package can have its own Biome configuration, but it should extend the workspace configuration
