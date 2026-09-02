import { ClaudeCodeTransformer } from '@lucasschirm/sal-claude-transformer';
import { TransformerRegistry } from '@lucasschirm/sal-transformer-shared';

/**
 * Composes the default `TransformerRegistry` for every transformer plugin
 * package the analytics platform ships today. This is the single place
 * that wires a new harness transformer package into production
 * (`packages/site/src/db/analytics-worker.ts`) and test composition roots —
 * adding a future harness plugin (e.g. devin-transformer, DS-F7 / #149)
 * means registering it here, not touching every consumer.
 */
export function createDefaultRegistry(): TransformerRegistry {
  const registry = new TransformerRegistry();
  registry.register(ClaudeCodeTransformer);
  return registry;
}
