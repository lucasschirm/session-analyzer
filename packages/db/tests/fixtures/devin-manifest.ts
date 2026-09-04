import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import type { SourceIdentity, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import {
  componentsBundle,
  linearBundle,
  subagentBundle,
} from '../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';
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

/**
 * The devin-transformer conformance fixtures hardcode the native
 * `sessions.id`/`message_nodes.session_id` to the constant `'test-sess'`
 * inside `transcript.jsonl`'s own content, independent of the manifest's
 * `sessionId` (which only drives artifact routing paths). Two manifests
 * built from the same source fixture with different manifest `sessionId`s
 * would otherwise still resolve to the exact same devin-transformer
 * `deriveSessionId(...)` output (same native session id + same source
 * scope) and collapse into one session — this rewrites the embedded native
 * id so each manifest's session is genuinely distinct when needed (e.g. to
 * test component identity stability *across* sessions).
 */
function cloneBundleWithNativeSessionId(
  bundle: UnknownArtifactBundle,
  nativeSessionId: string,
): UnknownArtifactBundle {
  return {
    ...bundle,
    artifacts: bundle.artifacts.map((a) => {
      if (normalizePath(a.relativePath) !== 'transcript.jsonl') return a;
      const content = typeof a.content === 'string' ? a.content : '';
      return { ...a, content: content.replaceAll('test-sess', nativeSessionId) };
    }),
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
    /**
     * Use the `componentsBundle` fixture (a `skill/<name>` cog, a
     * `core/model` AllowList cog with the 4 MCP wrapper tool names, a
     * `functions.skill` call, and a `functions.run_subagent` call) instead
     * of the plain `linearBundle`, to exercise cogs_json-derived
     * skill/tool/agent component ingestion and the skill/agent invocation
     * metrics end-to-end (DS-F11 (#288)).
     */
    readonly useComponentsBundle?: boolean;
    /**
     * Use the `subagentBundle` fixture (DS-B28 (#294): a foreground and a
     * background `run_subagent` invocation with real `subagent/*` tags and
     * synthetic prompt/result lines, a duplicate `message_nodes` pair, and
     * an orphaned sub-agent tree) instead of `linearBundle`, to exercise
     * Sub Agent evidence capture and the ordering-corruption fixes
     * end-to-end through real ingestion.
     */
    readonly useSubagentBundle?: boolean;
  } = {},
): Promise<DevinManifestFixture> {
  const projectId = options.projectId ?? 'devin-project';
  const sessionId = options.sessionId ?? 'devin-session';
  const sourceId = options.sourceId ?? 'default';
  const environmentId = options.environmentId ?? 'dev';

  let sourceBundle = options.useComponentsBundle
    ? componentsBundle
    : options.useSubagentBundle
      ? subagentBundle
      : linearBundle;
  sourceBundle = cloneBundleWithNativeSessionId(sourceBundle, sessionId);
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
