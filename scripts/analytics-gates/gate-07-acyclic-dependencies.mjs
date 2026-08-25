import { buildDependencyGraph, findCycles } from './lib/packages.mjs';
import { fail, pass } from './lib/runner.mjs';

const gate = 'acyclic dependencies';

const graph = buildDependencyGraph();
const cycles = findCycles(graph);

if (cycles.length > 0) {
  const formatted = cycles.map((c) => c.join(' -> ')).join('\n  ');
  fail(gate, `dependency cycle(s) detected:\n  ${formatted}`);
}
pass(gate);
