// A minimal, dependency-free assertion helper used only by the conformance
// suite. This package must never import `node:assert` (or any other `node:`
// module) — see tests/forbidden-imports.test.ts and
// .agents/rules/transformers-never-write-sqlite.md: the transformer contract
// layer is pure and runtime-agnostic, and the conformance suite is a public
// `src/` export any transformer plugin package (browser or Node) can import.

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ok(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function equal(actual: unknown, expected: unknown, message = 'Values are not equal'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\nExpected: ${stringify(expected)}\nActual: ${stringify(actual)}`);
  }
}

export function deepEqual(
  actual: unknown,
  expected: unknown,
  message = 'Values are not deeply equal',
): void {
  const actualJson = stringify(actual);
  const expectedJson = stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

export function fail(message: string): never {
  throw new Error(message);
}
