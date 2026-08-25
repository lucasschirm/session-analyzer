/**
 * Activation state and source-retention controls for the analytics database
 * cutover.
 *
 * The activation state is stored as JSON in the control database's
 * `ui_preferences` table so it survives analytics resets and is never written
 * to the analytics database itself.
 */

export interface SourceRetentionControls {
  /** Keep main session transcript source bytes locally. */
  readonly retainTranscripts: boolean;
  /** Keep Sub Agent transcript source bytes locally. */
  readonly retainSubAgents: boolean;
  /** Keep configuration artifacts (rules, skills, agents, MCP, settings, plugins). */
  readonly retainConfigurationArtifacts: boolean;
}

export interface AnalyticsActivationState {
  /** `legacy` uses the pre-split read-only database; `new` uses the fresh analytics database. */
  readonly mode: 'legacy' | 'new';
  /** When the user activated the new analytics database, in milliseconds. */
  readonly activatedAt?: number;
  /** Source-retention choices captured at activation time. */
  readonly retention: SourceRetentionControls;
  /** Whether the disclosure copy was shown and confirmed. */
  readonly disclosureConfirmed: boolean;
}

export const ACTIVATION_STATE_KEY = 'analytics_activation_state';

export const DEFAULT_SOURCE_RETENTION: SourceRetentionControls = {
  retainTranscripts: true,
  retainSubAgents: true,
  retainConfigurationArtifacts: true,
};

export interface DatabaseExportMetadata {
  /** What source and configuration content is retained in this export. */
  readonly retainedContent: readonly string[];
  /** Fields that may contain sensitive values even after normalization/redaction. */
  readonly sensitiveFields: readonly string[];
  /** Whether the digest/key domain used for sensitive-change detection is local. */
  readonly digestIsLocal: boolean;
}

export const DATABASE_EXPORT_METADATA: DatabaseExportMetadata = {
  retainedContent: [
    'Main session transcripts (when retention permits)',
    'Sub Agent transcripts (when retention permits)',
    'Configuration artifacts: rules, skills, agents, MCP servers, settings, plugins',
    'Normalized evidence: turns, messages, invocations, metrics, rollups',
    'Source pointers and safe path metadata',
  ],
  sensitiveFields: [
    'Transcript content may include prompts, file paths, command output, or error text',
    'Source pointers reference original file paths and line ranges',
    'Normalized paths are sanitized but may still identify project structure',
    'Digest values are keyed to this local database; portability to another key domain requires explicit rekey',
  ],
  digestIsLocal: true,
};

export function serializeActivationState(state: AnalyticsActivationState): string {
  return JSON.stringify(state);
}

export function parseActivationState(value: string | null): AnalyticsActivationState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const state = parsed as Record<string, unknown>;
    if (state.mode !== 'legacy' && state.mode !== 'new') return null;
    const retention = state.retention as Record<string, unknown> | undefined;
    if (!retention) return null;
    return {
      mode: state.mode,
      activatedAt: typeof state.activatedAt === 'number' ? state.activatedAt : undefined,
      retention: {
        retainTranscripts: Boolean(retention.retainTranscripts),
        retainSubAgents: Boolean(retention.retainSubAgents),
        retainConfigurationArtifacts: Boolean(retention.retainConfigurationArtifacts),
      },
      disclosureConfirmed: Boolean(state.disclosureConfirmed),
    };
  } catch {
    return null;
  }
}
