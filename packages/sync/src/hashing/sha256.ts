import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
