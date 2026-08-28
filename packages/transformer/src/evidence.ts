import type { Provenance } from './provenance.js';

export interface NormalizedEvidenceRecord {
  readonly recordId: string;
  readonly recordType: string;
  readonly sessionId: string;
  readonly parentId?: string;
  readonly sourceEventId: string;
  readonly sourceField?: string;
  readonly provenance: Provenance;
  readonly payload: unknown;
}
