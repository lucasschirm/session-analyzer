import type { SourcePointer } from './provenance.js';

export type ComponentKind =
  | 'tool'
  | 'skill'
  | 'agent'
  | 'subagent'
  | 'rule'
  | 'mcp'
  | 'settings'
  | 'model'
  | 'unknown';

export type ComponentCompleteness = 'complete' | 'partial' | 'unavailable' | 'unsupported';

export interface ComponentIdentity {
  readonly canonicalId: string;
  readonly nativeId?: string;
  readonly displayName?: string;
  readonly provider?: string;
  readonly integration?: string;
}

export interface ComponentSummary {
  readonly componentId: string;
  readonly kind: ComponentKind;
  readonly identity: ComponentIdentity;
  readonly version?: string;
  readonly sourceArtifactIds: readonly string[];
  readonly sourcePointer?: SourcePointer;
}

export interface ConfigurationSnapshot {
  readonly completeness: Readonly<Record<string, ComponentCompleteness>>;
  readonly components: readonly ComponentSummary[];
  readonly captureTime?: string;
  readonly temporalRole?: 'pre_session' | 'runtime' | 'post_session' | 'capture_only';
}
