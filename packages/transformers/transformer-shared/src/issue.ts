import type { Provenance } from './provenance.js';

export type IssueSeverity = 'warning' | 'fatal' | 'recoverable';

export interface Issue {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly provenance?: Provenance;
}

export interface DetectionIssue {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
