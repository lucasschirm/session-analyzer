/** Returns a reasonably unique, timestamped string id. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
