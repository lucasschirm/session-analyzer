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
  /**
   * `true` when the component was observed from this session's own runtime
   * data — e.g. a model-sent tool schema list (`prompt_snapshot` tools,
   * `deferred_tools_delta`, ATIF `agent.tool_definitions`) — rather than a
   * durable environment-level declaration (config file, manifest). Session-
   * scoped components still produce exposures and evidence links, but are
   * excluded from environment lifecycle diffing (added/updated/removed
   * inference) and use a stable, artifact-hash-independent version: a
   * per-session tool list is not a comparable complete environment
   * snapshot, and its source artifact changes hash every session.
   */
  readonly sessionScoped?: boolean;
}

export interface ConfigurationSnapshot {
  readonly completeness: Readonly<Record<string, ComponentCompleteness>>;
  readonly components: readonly ComponentSummary[];
  readonly captureTime?: string;
  readonly temporalRole?: 'pre_session' | 'runtime' | 'post_session' | 'capture_only';
}
