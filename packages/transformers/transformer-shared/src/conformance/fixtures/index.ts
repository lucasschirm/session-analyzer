import type { TransformContext, UnknownArtifactBundle } from '../../index.js';

export interface ConformanceFixture<TBundle = UnknownArtifactBundle> {
  readonly name: string;
  readonly bundle: TBundle;
  readonly context: TransformContext;
  readonly tags: readonly string[];
  readonly description: string;
}

export interface TransformerFixtures<TBundle = UnknownArtifactBundle> {
  readonly fixtures: readonly ConformanceFixture<TBundle>[];
}
