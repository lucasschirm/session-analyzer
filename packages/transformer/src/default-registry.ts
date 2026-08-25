import { ClaudeCodeTransformer } from './plugin/claude-code.js';
import { TransformerRegistry } from './registry.js';

export function createDefaultRegistry(): TransformerRegistry {
  const registry = new TransformerRegistry();
  registry.register(ClaudeCodeTransformer);
  return registry;
}
