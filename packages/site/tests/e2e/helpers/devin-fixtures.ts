import { linearBundle } from '../../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';

export interface DevinFileSpec {
  readonly name: string;
  readonly relativePath: string;
  readonly content: string;
  readonly mediaType: string;
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
  return linearBundle.artifacts.map((artifact) => {
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
