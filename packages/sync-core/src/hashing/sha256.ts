/**
 * Return the lowercase hexadecimal SHA-256 digest of `data`.
 *
 * `data` must be a `BufferSource` such as a `Uint8Array`; no copy is made.
 */
export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const view = new Uint8Array(buffer);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
