/**
 * Maps a Devin `chat_message.role` value (`system|user|assistant|tool`, per
 * the master plan's A2 research digest) to a normalized role, with a
 * non-crashing fallback for any unrecognized value.
 */

const KNOWN_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

export type DevinKnownRole = (typeof KNOWN_ROLES)[number];
export type DevinNormalizedRole = DevinKnownRole | 'unknown';

/** `true` when `value` is one of the four known `chat_message.role` values. */
export function isKnownDevinRole(value: unknown): value is DevinKnownRole {
  return typeof value === 'string' && (KNOWN_ROLES as readonly string[]).includes(value);
}

/**
 * Normalizes a raw `chat_message.role` value. Unrecognized values (including
 * `undefined`/non-string values) map to `'unknown'` rather than throwing, so
 * a future Devin CLI role addition degrades gracefully instead of crashing
 * the parser.
 */
export function mapDevinRole(value: unknown): DevinNormalizedRole {
  return isKnownDevinRole(value) ? value : 'unknown';
}
