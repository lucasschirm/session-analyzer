export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  const view = new Uint8Array(buffer);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
