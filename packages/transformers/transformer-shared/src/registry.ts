import type { UnknownArtifactBundle } from './bundle.js';
import type { SessionTransformer } from './plugin/contract.js';

export type RegistryResolution =
  | {
      readonly kind: 'matched';
      readonly plugin: SessionTransformer<unknown>;
      readonly harness: string;
    }
  | {
      readonly kind: 'unmatched';
      readonly reason: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly reason: string;
      readonly candidates: readonly string[];
    };

export class TransformerRegistry {
  private readonly plugins = new Map<string, SessionTransformer<unknown>>();
  private readonly harnessIndex = new Map<string, SessionTransformer<unknown>>();

  register<TBundle>(plugin: SessionTransformer<TBundle>): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`plugin already registered: ${plugin.id}`);
    }

    for (const harness of plugin.harnesses) {
      if (this.harnessIndex.has(harness)) {
        throw new Error(`harness already registered: ${harness}`);
      }
      this.harnessIndex.set(harness, plugin as SessionTransformer<unknown>);
    }

    this.plugins.set(plugin.id, plugin as SessionTransformer<unknown>);
  }

  resolve(harness: string): SessionTransformer<unknown> {
    const plugin = this.harnessIndex.get(harness);
    if (!plugin) {
      throw new Error(`no transformer registered for harness: ${harness}`);
    }
    return plugin;
  }

  resolveByDetection(bundle: UnknownArtifactBundle): RegistryResolution {
    const matched: Array<{ plugin: SessionTransformer<unknown>; harness: string }> = [];

    for (const plugin of this.plugins.values()) {
      const result = plugin.detect(bundle);
      if (result.kind === 'matched') {
        matched.push({ plugin, harness: result.harness });
      } else if (result.kind === 'ambiguous') {
        for (const harness of result.candidates) {
          matched.push({ plugin, harness });
        }
      }
    }

    if (matched.length === 0) {
      return {
        kind: 'unmatched',
        reason: 'no transformer detected this bundle',
      };
    }

    if (matched.length > 1) {
      const candidateIds = matched.map((m) => `${m.plugin.id}:${m.harness}`);
      return {
        kind: 'ambiguous',
        reason: 'multiple transformers matched the bundle',
        candidates: candidateIds,
      };
    }

    return {
      kind: 'matched',
      plugin: matched[0].plugin,
      harness: matched[0].harness,
    };
  }

  ids(): readonly string[] {
    return Array.from(this.plugins.keys());
  }

  harnesses(): readonly string[] {
    return Array.from(this.harnessIndex.keys());
  }
}
