import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './runner.mjs';

export function getWorkspacePackages() {
  const packages = [];
  const globs = ['packages/*', 'packages/parsers/*', 'packages/plugins/*'];
  for (const glob of globs) {
    const base = join(repoRoot, glob.replace('/*', ''));
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      if (!statSync(dir).isDirectory()) continue;
      const pkgPath = join(dir, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        packages.push({
          name: pkg.name,
          dir,
          relDir: relative(repoRoot, dir),
          packageJson: pkg,
        });
      } catch {
        // not a workspace package
      }
    }
  }
  return packages;
}

export function buildDependencyGraph() {
  const packages = getWorkspacePackages();
  const byName = new Map(packages.map((p) => [p.name, p]));
  const edges = new Map();
  for (const pkg of packages) {
    const deps = [
      ...Object.entries(pkg.packageJson.dependencies ?? {}),
      ...Object.entries(pkg.packageJson.devDependencies ?? {}),
    ];
    const targets = [];
    for (const [name, spec] of deps) {
      if (byName.has(name) || spec === 'workspace:*' || spec.startsWith('workspace:')) {
        const target = byName.get(name);
        if (target) targets.push(target.name);
      }
    }
    edges.set(pkg.name, [...new Set(targets)]);
  }
  return { packages, byName, edges };
}

export function findCycles(graph) {
  const { edges } = graph;
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(name, path) {
    if (stack.has(name)) {
      const start = path.indexOf(name);
      cycles.push([...path.slice(start), name]);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    stack.add(name);
    for (const target of edges.get(name) ?? []) {
      dfs(target, [...path, target]);
    }
    stack.delete(name);
  }

  for (const name of edges.keys()) {
    if (!visited.has(name)) dfs(name, [name]);
  }
  return cycles;
}
