import type { ArtifactScope } from './bundle.js';
import type { ComponentSummary, ConfigurationSnapshot } from './component.js';
import type { Issue } from './issue.js';
import type { SourcePointer } from './provenance.js';

export type ArtifactKind =
  | 'transcript'
  | 'subagent'
  | 'skill'
  | 'agent'
  | 'rule'
  | 'mcp'
  | 'settings'
  | 'tool'
  | 'unclassified';

export type ClassifierConfidence = 'exact' | 'inferred' | 'unclassified';

export interface ClassifiedArtifact {
  readonly relativePath: string;
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  readonly role?: string;
  readonly mediaType: string;
  readonly sha256?: string;
  readonly confidence: ClassifierConfidence;
  readonly reason?: string;
  readonly sourcePointers?: readonly SourcePointer[];
}

export interface ArtifactClassificationResult {
  readonly artifacts: readonly ClassifiedArtifact[];
  readonly configurationSnapshot: ConfigurationSnapshot;
  readonly components: readonly ComponentSummary[];
  readonly warnings?: readonly Issue[];
}
