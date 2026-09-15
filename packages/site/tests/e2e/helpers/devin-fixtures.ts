import type { UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import {
  linearBundle,
  modelSwitchBundle,
} from '../../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';

export interface DevinFileSpec {
  readonly name: string;
  readonly relativePath: string;
  readonly content: string;
  readonly mediaType: string;
}

function bundleToFiles(source: UnknownArtifactBundle): DevinFileSpec[] {
  return source.artifacts.map((artifact) => {
    const relativePath = artifact.relativePath;
    const name = relativePath.split('/').pop() ?? relativePath;
    const content =
      typeof artifact.content === 'string'
        ? artifact.content
        : new TextDecoder().decode(artifact.content as Uint8Array);
    const mediaType =
      artifact.mediaType ??
      (relativePath.toLowerCase().endsWith('.jsonl')
        ? 'application/jsonl'
        : relativePath.toLowerCase().endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream');
    return { name, relativePath, content, mediaType };
  });
}

/**
 * Convert the golden Devin fixture bundle into file specs that can be used
 * to drive the Manual Import flow or the sync CAS mock.
 *
 * The relative paths (including `native/`) are preserved so the Devin
 * transformer can classify the ATIF transcript, models list, and schema
 * descriptor as their proper artifact kinds.
 */
export function devinLinearFiles(): DevinFileSpec[] {
  return bundleToFiles(linearBundle);
}

/**
 * The mid-session model-switch bundle (DS-B25): four chat messages across
 * two ATIF agent-generation steps with per-step `model_usage` metrics on
 * distinct models (glm-5-2 -> swe-1-7), plus one `EditFile` tool call.
 *
 * Used by E2E specs that need a non-flat context-growth chart (per-step
 * token attribution) and a real tool invocation for the utilization panel.
 */
export function devinModelSwitchFiles(): DevinFileSpec[] {
  return bundleToFiles(modelSwitchBundle);
}

/**
 * Content of the root transcript for tests that only need `transcript.jsonl`.
 */
export function devinTranscriptContent(): string {
  const artifact = linearBundle.artifacts.find(
    (a) => a.relativePath.toLowerCase() === 'transcript.jsonl',
  );
  if (!artifact) throw new Error('transcript.jsonl not found in linearBundle');
  return typeof artifact.content === 'string'
    ? artifact.content
    : new TextDecoder().decode(artifact.content as Uint8Array);
}
