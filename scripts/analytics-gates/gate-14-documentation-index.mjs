import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspacePackages } from './lib/packages.mjs';
import { fail, pass, repoRoot } from './lib/runner.mjs';

const gate = 'documentation index';

const errors = [];

// ADR README lists all ADR files.
const adrDir = join(repoRoot, 'docs/architecture/adr');
const adrReadme = readFileSync(join(adrDir, 'README.md'), 'utf8');
const adrFiles = readdirSync(adrDir)
  .filter((f) => /^\d{4}-.*\.md$/.test(f) && f !== 'README.md')
  .map((f) => f.replace(/\.md$/, ''));
for (const adr of adrFiles) {
  if (!adrReadme.includes(adr)) {
    errors.push(`ADR README does not reference ${adr}`);
  }
}

// Architecture docs reference every workspace package.
const architectureDocs = [
  'docs/architecture/metrics/README.md',
  'docs/architecture/schema/README.md',
  'docs/architecture/harnesses/README.md',
];

// AGENTS.md root is not stale and references key repo artifacts.
const rootAgents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

const packageNames = getWorkspacePackages().map((p) => p.name);
const packageBasenames = getWorkspacePackages().map((p) => p.relDir.replace(/^packages\//, ''));

const docsText = architectureDocs
  .map((p) => readFileSync(join(repoRoot, p), 'utf8'))
  .join('\n')
  .concat('\n', rootAgents);
for (const pkg of packageNames) {
  const basename = packageBasenames[packageNames.indexOf(pkg)];
  if (!docsText.includes(pkg) && !docsText.includes(basename)) {
    errors.push(`package ${pkg} is not referenced in architecture documentation`);
  }
}
const requiredAgentsRefs = [
  'scripts/analytics-gates',
  'packages/db-core',
  'packages/db',
  'packages/transformer',
  '.agents/skills',
  '.agents/rules',
];
for (const ref of requiredAgentsRefs) {
  if (!rootAgents.includes(ref)) {
    errors.push(`root AGENTS.md does not reference ${ref}`);
  }
}

// Each agent skill has a SKILL.md and is reachable from docs/AGENTS.md.
const skillsDir = join(repoRoot, '.agents/skills');
const skillDirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
for (const skill of skillDirs) {
  const skillMd = join(skillsDir, skill, 'SKILL.md');
  try {
    const skillText = readFileSync(skillMd, 'utf8');
    if (!skillText.trim()) errors.push(`empty skill file: ${skillMd}`);
  } catch {
    errors.push(`missing skill file: ${skillMd}`);
  }
  if (!docsText.includes(skill) && !rootAgents.includes(skill)) {
    errors.push(`skill ${skill} is not referenced in docs or AGENTS.md`);
  }
}

// Each agent rule is reachable from AGENTS.md.
const rulesDir = join(repoRoot, '.agents/rules');
const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
for (const rule of ruleFiles.map((f) => f.replace(/\.md$/, ''))) {
  if (!rootAgents.includes(rule)) {
    errors.push(`rule ${rule} is not referenced in root AGENTS.md`);
  }
}

// The new scripts folder has its own AGENTS.md.
const scriptsAgents = join(repoRoot, 'scripts/analytics-gates/AGENTS.md');
try {
  const agentsText = readFileSync(scriptsAgents, 'utf8');
  if (!agentsText.includes('analytics-gates')) {
    errors.push('scripts/analytics-gates/AGENTS.md does not describe the folder');
  }
} catch {
  errors.push('missing scripts/analytics-gates/AGENTS.md');
}

// The E2E coverage catalog exists, has a §6 catalog, every top-level
// packages/site/tests/e2e/*.spec.ts file is represented in it, and every
// catalog ID (UX-###/PIPE-###/SYNC-###) cited in specs resolves to a row.
const catalogPath = join(repoRoot, 'docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md');
let catalogText = '';
try {
  catalogText = readFileSync(catalogPath, 'utf8');
} catch {
  errors.push(
    'missing docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md (required by .agents/rules/e2e-coverage-required.md §6)',
  );
}
if (catalogText) {
  if (!/(^|\n)#{1,3}\s*6[.\s]/.test(catalogText) && !catalogText.includes('§6')) {
    errors.push('e2e coverage catalog is missing a §6 / "6." catalog section');
  }

  const e2eDir = join(repoRoot, 'packages/site/tests/e2e');
  const specFiles = readdirSync(e2eDir).filter(
    (f) => f.endsWith('.spec.ts') && statSync(join(e2eDir, f)).isFile(),
  );
  for (const spec of specFiles) {
    if (!catalogText.includes(spec)) {
      errors.push(`e2e coverage catalog does not reference spec file ${spec}`);
    }
  }

  const idPattern = /\b(UX|PIPE|SYNC)-\d{3}\b/g;
  const citedIds = new Set();
  const scanDirs = [
    'packages/site/tests/e2e',
    'packages/db/tests/pipeline',
    'packages/sync/tests/e2e',
    'packages/plugins/claude-session-sync/tests/e2e',
    'packages/site/tests/unit',
  ];
  const scanFile = (path) => {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(idPattern)) citedIds.add(match[0]);
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) scanFile(full);
    }
  };
  for (const dir of scanDirs) walk(join(repoRoot, dir));

  for (const id of citedIds) {
    const row = new RegExp(`\\|\\s*${id}\\s*\\|`);
    if (!row.test(catalogText)) {
      errors.push(`catalog ID ${id} is cited in a spec but has no row in the e2e coverage catalog`);
    }
  }
}

if (errors.length > 0) {
  fail(gate, errors.join('\n'));
}
pass(gate);
