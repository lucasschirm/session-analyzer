import type { PluginMarketplace } from '../types/config.js';

// TODO(T6): implement — see spec §3 (PluginMarketplace) + §4 (parsePluginMarketplace)
export function parsePluginMarketplace(content: string, sourcePath?: string): PluginMarketplace {
  void content;
  return {
    kind: 'plugin-marketplace',
    sourcePath,
    name: '',
    plugins: [],
  };
}
