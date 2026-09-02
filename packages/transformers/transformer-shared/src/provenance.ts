export interface Provenance {
  readonly artifactId?: string;
  readonly sourceEventId?: string;
  readonly sourceField?: string;
  readonly path?: string;
}

export interface SourcePointer {
  readonly path?: string;
  readonly jsonPointer?: string;
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
}
