/**
 * Read and JSON-parse the full contents of a stream (defaulting to
 * `process.stdin`), used by every harness plugin's hook entry points
 * (`SessionStart`/`SessionEnd`/generic hook) to receive the harness's hook
 * payload. Resolves `undefined` (never rejects on parse failure) for empty
 * or non-JSON input so a malformed/absent hook payload degrades to argv-based
 * fallback parsing instead of crashing the hook.
 *
 * Shared verbatim by every harness plugin — this logic has no
 * harness-specific content.
 */
export function readStdin(stdin: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    });

    stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });

    stdin.on('error', reject);
  });
}
