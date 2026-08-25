import type { UnknownArtifactBundle } from '../bundle.js';
import type { ArtifactClassificationResult } from '../classification.js';
import type { ComponentSummary, ConfigurationSnapshot } from '../component.js';
import type { TransformContext } from '../context.js';
import type { NormalizedEvidenceRecord } from '../evidence.js';
import type { DetectionIssue, Issue } from '../issue.js';
import type {
  Distribution,
  MetricCapability,
  MetricUnavailableReason,
  ScalarMetricValue,
} from '../metric.js';
import type { Provenance } from '../provenance.js';
import type { SessionSummary } from '../session.js';

export type DetectionResult =
  | {
      readonly kind: 'matched';
      readonly harness: string;
      readonly confidence: number;
      readonly reason?: string;
      readonly issues?: readonly DetectionIssue[];
    }
  | {
      readonly kind: 'unmatched';
      readonly reason: string;
      readonly issues?: readonly DetectionIssue[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly reason: string;
      readonly candidates: readonly string[];
      readonly issues?: readonly DetectionIssue[];
    };

export interface TransformResult {
  readonly bundleHash: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly transformerId: string;
  readonly transformerVersion: string;
  readonly ontologyVersion: string;
  readonly metricDefinitionVersion: string;
  readonly estimationMethodVersion?: string;
  readonly evidence: readonly NormalizedEvidenceRecord[];
  readonly sessionSummaries: readonly SessionSummary[];
  readonly componentSummaries: readonly ComponentSummary[];
  readonly metricValues: readonly ScalarMetricValue[];
  readonly distributions: readonly Distribution[];
  readonly configurationSnapshot: ConfigurationSnapshot;
  readonly capabilities: readonly MetricCapability[];
  readonly unavailableReasons: readonly MetricUnavailableReason[];
  readonly provenance: readonly Provenance[];
  readonly warnings: readonly Issue[];
  readonly errors: readonly Issue[];
}

export interface SessionTransformer<TBundle> {
  readonly id: string;
  readonly harnesses: readonly string[];
  readonly transformerVersion: string;
  readonly ontologyVersion: string;

  detect(bundle: UnknownArtifactBundle): DetectionResult;
  classifyArtifacts(bundle: TBundle): ArtifactClassificationResult;
  getCapabilities(bundle?: TBundle): MetricCapability[];
  transform(bundle: TBundle, context: TransformContext): TransformResult;
}
