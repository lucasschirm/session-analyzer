export function getOrThrow<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Invariant violated: no map entry for key ${String(key)}`);
  }
  return value;
}
