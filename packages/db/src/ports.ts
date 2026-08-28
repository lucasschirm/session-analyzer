export type ArtifactContent = string | Uint8Array;

/**
 * Credential-free source location. The opaque reacquisition key is provided by
 * the caller runtime; analytics never stores credentials, secrets, or signed
 * URLs.
 */
export interface SourceLocation {
  readonly reacquisitionKey: string;
  readonly sourceNamespace: string;
  readonly relativePath: string;
  readonly retentionClass: 'transient' | 'local' | 'archive';
}

export interface ArtifactReference {
  readonly sha256: string;
  readonly size: number;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly sourceLocation?: SourceLocation;
}

export interface ResolvedArtifact extends ArtifactReference {
  readonly content: ArtifactContent;
}

/**
 * Resolves an artifact reference to its verified content. Implementations are
 * runtime-owned: the site uses a sync cache adapter, a server uses its own
 * storage adapter.
 */
export interface ArtifactResolver {
  resolve(reference: ArtifactReference): Promise<ResolvedArtifact>;
}

/**
 * Content-addressable hashing used to verify artifact integrity before
 * transformation.
 */
export interface ContentHasher {
  hash(content: ArtifactContent): Promise<string>;
}

/**
 * Optional local blob store for retained artifacts. Analytics never stores
 * credentials with the retained source references.
 */
export interface ArtifactBlobStore {
  retain(blob: ResolvedArtifact): Promise<ArtifactReference>;
  read(sha256: string): Promise<ResolvedArtifact | undefined>;
  remove(sha256: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly ArtifactReference[]>;
}
