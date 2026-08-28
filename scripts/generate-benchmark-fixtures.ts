import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BenchmarkScale,
  generateBenchmarkFixture,
  getManualBundle,
} from '../packages/db/tests/fixtures/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCALE_PRESETS = {
  small: {
    projects: 2,
    sources: 2,
    environments: 2,
    sessions: 20,
    childDepth: 1,
    childCount: 2,
    evidenceCount: 5,
    payloadSize: 100,
    componentCount: 3,
  },
  ci: {
    projects: 3,
    sources: 2,
    environments: 2,
    sessions: 50,
    childDepth: 2,
    childCount: 2,
    evidenceCount: 5,
    payloadSize: 100,
    componentCount: 5,
  },
  large: {
    projects: 10,
    sources: 5,
    environments: 5,
    sessions: 1000,
    childDepth: 2,
    childCount: 2,
    evidenceCount: 10,
    payloadSize: 1000,
    componentCount: 10,
  },
} satisfies Record<string, BenchmarkScale>;

type ScaleName = keyof typeof SCALE_PRESETS;

function parseArgs(): { scale: ScaleName; output?: string } {
  const args = process.argv.slice(2);
  let scale: ScaleName = 'small';
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scale' || arg === '-s') {
      const value = args[++i];
      if (value && value in SCALE_PRESETS) {
        scale = value as ScaleName;
      } else {
        throw new Error(
          `Unknown scale: ${value}. Use one of: ${Object.keys(SCALE_PRESETS).join(', ')}`,
        );
      }
    } else if (arg === '--output' || arg === '-o') {
      output = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: tsx scripts/generate-benchmark-fixtures.ts [--scale small|ci|large] [--output path]`,
      );
      process.exit(0);
    }
  }

  return { scale, output };
}

async function main() {
  const { scale, output } = parseArgs();
  const fixture = generateBenchmarkFixture(SCALE_PRESETS[scale]);

  const totalSessions = fixture.sessions.length;
  const rootSessions = fixture.rootSessions.length;
  const totalEvidence = fixture.sessions.reduce((sum, s) => sum + s.evidenceCount, 0);
  const totalComponents = fixture.sessions.reduce((sum, s) => sum + s.componentCount, 0);

  const summary = {
    scale,
    rootSessions,
    totalSessions,
    totalEvidence,
    totalComponents,
    projects: fixture.projects.length,
    sources: fixture.sources.length,
    environments: fixture.environments.length,
    sampleSession: fixture.sessions[0]?.sessionId,
  };

  console.log('Generated benchmark fixture:');
  console.log(JSON.stringify(summary, null, 2));

  if (output) {
    const outputPath = join(__dirname, '..', output);
    await mkdir(dirname(outputPath), { recursive: true });
    const bundles = await Promise.all(fixture.rootSessions.map((s) => getManualBundle(s)));
    const outputJson = {
      summary,
      fixture,
      bundles,
    };
    await writeFile(outputPath, JSON.stringify(outputJson, null, 2));
    console.log(`Wrote fixture to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
