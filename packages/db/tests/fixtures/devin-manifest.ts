import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import type { SourceIdentity, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { linearBundle } from '../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';
import { createSha256ContentHasher } from '../../src/ingestion.js';
import type { VerifiedManifestBundle } from '../../src/manifest.js';
import type { ResolvedArtifact } from '../../src/ports.js';

const hasher = createSha256ContentHasher();

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').toLowerCase();
}

function artifactScope(relativePath: string): ManifestArtifact['scope'] {
  const normalized = normalizePath(relativePath);
  if (normalized.startsWith('native/')) return 'runtime';
  if (normalized.startsWith('plans/')) return 'session';
  if (normalized.startsWith('.devin/')) return 'workspace';
  if (normalized === 'config.json') return 'global';
  return 'session';
}

function artifactRole(relativePath: string): string | undefined {
  const normalized = normalizePath(relativePath);
  if (normalized === 'native/atif-transcript.json') return 'native';
  if (normalized === 'native/models.json') return 'models';
  if (normalized === 'native/models-list.raw.json') return 'models-raw';
  if (normalized === 'native/schema-descriptor.json') return 'schema';
  if (normalized.startsWith('plans/')) return 'plan';
  return undefined;
}

function artifactMediaType(relativePath: string, fallback?: string): string {
  const normalized = normalizePath(relativePath);
  if (normalized.endsWith('.jsonl')) return 'application/jsonl';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.md')) return 'text/markdown';
  return fallback ?? 'application/octet-stream';
}

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  return '';
}

function cloneBundleWithRootTranscript(
  bundle: UnknownArtifactBundle,
  content: unknown,
): UnknownArtifactBundle {
  return {
    ...bundle,
    artifacts: bundle.artifacts.map((a) =>
      normalizePath(a.relativePath) === 'transcript.jsonl'
        ? { ...a, content, mediaType: a.mediaType ?? 'application/jsonl' }
        : a,
    ),
  };
}

export interface DevinManifestFixture {
  readonly bundle: VerifiedManifestBundle;
  readonly resolvedArtifacts: readonly ResolvedArtifact[];
  readonly sourceIdentity: SourceIdentity;
}

export async function buildDevinManifestBundle(
  options: {
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly environmentId?: string;
    readonly sourceId?: string;
    readonly corruptRootTranscript?: boolean;
  } = {},
): Promise<DevinManifestFixture> {
  const projectId = options.projectId ?? 'devin-project';
  const sessionId = options.sessionId ?? 'devin-session';
  const sourceId = options.sourceId ?? 'default';
  const environmentId = options.environmentId ?? 'dev';

  let sourceBundle = linearBundle;
  if (options.corruptRootTranscript) {
    sourceBundle = cloneBundleWithRootTranscript(sourceBundle, '');
  }

  const resolvedArtifacts: ResolvedArtifact[] = [];
  const manifestArtifacts: ManifestArtifact[] = [];

  for (const a of sourceBundle.artifacts) {
    const content = toText(a.content);
    const sha256 = await hasher.hash(content);
    const size = content.length;
    const relativePath = a.relativePath;
    const mediaType = artifactMediaType(relativePath, a.mediaType);
    const scope = artifactScope(relativePath);

    resolvedArtifacts.push({
      relativePath,
      mediaType,
      sha256,
      size,
      content,
    });

    manifestArtifacts.push({
      projectId,
      sessionId,
      scope,
      relativePath,
      sha256,
      size,
      status: 'uploaded',
      mediaType,
      role: artifactRole(relativePath),
    });
  }

  const manifest: SyncManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    sessionId,
    harness: 'devin',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: 'transcript.jsonl',
    artifacts: manifestArtifacts,
    syncRuns: [],
  };

  const sourceIdentity: SourceIdentity = {
    sourceId,
    environmentId,
    projectId,
    sessionId,
  };

  return {
    bundle: {
      manifest,
      source: sourceIdentity,
      resolvedArtifacts,
      integrityVerified: false,
    },
    resolvedArtifacts,
    sourceIdentity,
  };
}
