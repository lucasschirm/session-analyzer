import { describe, expect, it } from 'vitest';
import {
  metricDescription,
  metricLabel,
  stripScopeSuffix,
} from '../../src/lib/metric-descriptions';

describe('metricLabel', () => {
  it('resolves domain labels for claude metrics', () => {
    expect(metricLabel('claude:tokens:total:root_only')).toBe('Total tokens');
    expect(metricLabel('claude:tokens:input:root_only')).toBe('Input tokens');
    expect(metricLabel('claude:tokens:output:inclusive')).toBe('Output tokens');
    expect(metricLabel('claude:cost:total:root_only')).toBe('Total cost');
    expect(metricLabel('claude:turns:count:root_only')).toBe('Turn count');
    expect(metricLabel('claude:invocations:tool:root_only')).toBe('Tool invocations');
    expect(metricLabel('claude:invocations:skill:root_only')).toBe('Skill invocations');
    expect(metricLabel('claude:invocations:agent:root_only')).toBe('Agent invocations');
    expect(metricLabel('claude:file_operations:count:root_only')).toBe('File operation count');
    expect(metricLabel('claude:commands:count:root_only')).toBe('Command count');
    expect(metricLabel('claude:validations:count:root_only')).toBe('Validation count');
    expect(metricLabel('claude:effort:changes:root_only')).toBe('Effort-level changes');
  });

  it('resolves domain labels for devin metrics', () => {
    expect(metricLabel('devin:tokens:total:inclusive')).toBe('Total tokens');
    expect(metricLabel('devin:tokens:prompt:root_only')).toBe('Prompt tokens');
    expect(metricLabel('devin:tokens:completion:root_only')).toBe('Completion tokens');
    expect(metricLabel('devin:tokens:cached:root_only')).toBe('Cached tokens');
    expect(metricLabel('devin:steps:count:root_only')).toBe('Step count');
    expect(metricLabel('devin:cost:total:root_only')).toBe('Total cost');
  });

  it('resolves synthetic portfolio metric labels', () => {
    expect(metricLabel('portfolio-project-count')).toBe('Project count');
    expect(metricLabel('portfolio-session-count')).toBe('Session count');
    expect(metricLabel('portfolio-component-count')).toBe('Component count');
    expect(metricLabel('portfolio-unused-components')).toBe('Unused offered components');
  });

  it('resolves synthetic component ecosystem metric labels', () => {
    expect(metricLabel('total-components')).toBe('Total components');
    expect(metricLabel('total-load-rate')).toBe('Load rate');
    expect(metricLabel('total-invoke-rate')).toBe('Invoke rate');
    expect(metricLabel('total-overhead')).toBe('Overhead');
  });

  it('returns "Session duration (min)" for duration metrics', () => {
    expect(metricLabel('claude:duration:wall_ms:root_only')).toBe('Session duration (min)');
    expect(metricLabel('devin:duration:wall_ms:inclusive')).toBe('Session duration (min)');
  });

  it('falls back to the provided fallback with scope suffix stripped', () => {
    expect(metricLabel('unknown:metric', 'Custom Label (root-only)')).toBe('Custom Label');
    expect(metricLabel('unknown:metric', 'Custom Label (inclusive)')).toBe('Custom Label');
  });

  it('falls back to the raw metricId when no match and no fallback', () => {
    expect(metricLabel('unknown:metric')).toBe('unknown:metric');
  });
});

describe('metricDescription', () => {
  it('resolves descriptions for domain metrics', () => {
    const desc = metricDescription('claude:tokens:total:root_only');
    expect(desc).toContain('Sum of all token classes');
    expect(desc).toContain('root-only');
  });

  it('resolves descriptions for devin domain metrics', () => {
    const desc = metricDescription('devin:tokens:total:inclusive');
    expect(desc).toContain('Sum of all token classes');
    expect(desc).toContain('inclusive');
  });

  it('resolves descriptions for synthetic portfolio metrics', () => {
    const desc = metricDescription('portfolio-project-count');
    expect(desc).toContain('Total number of projects');
  });

  it('returns a generic fallback for unknown metrics', () => {
    const desc = metricDescription('unknown:metric');
    expect(desc).toContain('derived from session analytics');
  });

  it('appends scope suffix for domain metrics but not for exact metrics', () => {
    const domainDesc = metricDescription('claude:cost:total:root_only');
    expect(domainDesc).toContain('root-only');

    const exactDesc = metricDescription('portfolio-project-count');
    expect(exactDesc).not.toContain('root-only');
    expect(exactDesc).not.toContain('inclusive');
  });
});

describe('stripScopeSuffix', () => {
  it('strips (root-only) suffix', () => {
    expect(stripScopeSuffix('Total Tokens (root-only)')).toBe('Total Tokens');
  });

  it('strips (inclusive) suffix', () => {
    expect(stripScopeSuffix('Total Tokens (inclusive)')).toBe('Total Tokens');
  });

  it('leaves labels without scope suffix unchanged', () => {
    expect(stripScopeSuffix('Total Tokens')).toBe('Total Tokens');
  });
});
