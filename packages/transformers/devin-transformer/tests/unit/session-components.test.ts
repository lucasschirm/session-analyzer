import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import {
  componentsBundle,
  defaultContext,
  linearBundle,
  skillCogOnlyBundle,
  skillInvocationOnlyBundle,
} from '../conformance/fixtures/index.js';

function componentsByKind(result: ReturnType<typeof DevinTransformer.transform>, kind: string) {
  return result.componentSummaries.filter((c) => c.kind === kind);
}

describe('DevinTransformer session components (DS-F11 #288)', () => {
  it('derives exactly one skill component for a skill/<name> cog with a matching invocation', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const skills = componentsByKind(result, 'skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].identity.nativeId).toBe('add-e2e-test');
    expect(skills[0].identity.integration).toBe('devin');
  });

  it('classifies the matching invocation evidence record as kind: skill, not tool', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const invocation = result.evidence.find(
      (r) => r.recordType === 'invocation' && r.sourceEventId === 'tc-skill-1',
    );
    expect(invocation).toBeDefined();
    const payload = invocation?.payload as { kind?: string; name?: string } | undefined;
    expect(payload?.kind).toBe('skill');
    expect(payload?.name).toBe('add-e2e-test');
  });

  it('derives exactly one agent component for a run_subagent call with rawInput.profile', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const agents = componentsByKind(result, 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0].identity.nativeId).toBe('pr-review');
  });

  it('classifies the run_subagent invocation evidence record as kind: agent, not tool', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const invocation = result.evidence.find(
      (r) => r.recordType === 'invocation' && r.sourceEventId === 'tc-agent-1',
    );
    expect(invocation).toBeDefined();
    const payload = invocation?.payload as { kind?: string; name?: string } | undefined;
    expect(payload?.kind).toBe('agent');
    expect(payload?.name).toBe('pr-review');
  });

  it('derives exactly 4 MCP wrapper tool components, excluding the ~23 other AllowList names', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const tools = componentsByKind(result, 'tool');
    const nativeIds = tools.map((t) => t.identity.nativeId).sort();
    expect(nativeIds).toEqual([
      'mcp_call_tool',
      'mcp_list_servers',
      'mcp_list_tools',
      'mcp_read_resource',
    ]);
    for (const tool of tools) {
      expect(tool.identity.provider).toBe('mcp');
    }
  });

  it('excludes skill/agent calls from the tool invocation count (regression guard)', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    const toolMetric = result.metricValues.find(
      (m) => m.metricId === 'devin:invocations:tool:root_only',
    );
    // No edit/execute/search-classified (non-skill/agent) calls exist in this
    // fixture — only the skill and run_subagent calls — so the tool count
    // must be 0, proving they were not folded into the generic tool pool.
    expect(toolMetric?.value).toBe(0);
    expect(toolMetric?.exact).toBe(true);
  });

  it('a session with no skill/agent calls has zero skill/agent components and a real, exact 0 count', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(componentsByKind(result, 'skill')).toHaveLength(0);
    expect(componentsByKind(result, 'agent')).toHaveLength(0);
    const skillMetric = result.metricValues.find(
      (m) => m.metricId === 'devin:invocations:skill:root_only',
    );
    const agentMetric = result.metricValues.find(
      (m) => m.metricId === 'devin:invocations:agent:root_only',
    );
    expect(skillMetric?.value).toBe(0);
    expect(skillMetric?.exact).toBe(true);
    expect(agentMetric?.value).toBe(0);
    expect(agentMetric?.exact).toBe(true);
    expect(
      result.unavailableReasons.some((r) => r.metricId === 'devin:invocations:skill:root_only'),
    ).toBe(false);
    expect(
      result.unavailableReasons.some((r) => r.metricId === 'devin:invocations:agent:root_only'),
    ).toBe(false);
  });

  it('derives a skill component from a cog with no matching tool_call_state invocation', () => {
    const result = DevinTransformer.transform(skillCogOnlyBundle, defaultContext);
    const skills = componentsByKind(result, 'skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].identity.nativeId).toBe('add-e2e-test');
    // No tool_call_state evidence for this skill in this bundle: the
    // invocation-count metric is driven only by tool_call_state, not cog
    // presence, and must stay 0 (two different evidence sources, DS-F11 §2).
    const skillMetric = result.metricValues.find(
      (m) => m.metricId === 'devin:invocations:skill:root_only',
    );
    expect(skillMetric?.value).toBe(0);
  });

  it('counts a functions.skill invocation with no matching skill/<name> cog', () => {
    const result = DevinTransformer.transform(skillInvocationOnlyBundle, defaultContext);
    // No cogs_json at all in this bundle: no skill component is derived...
    expect(componentsByKind(result, 'skill')).toHaveLength(0);
    // ...but the invocation-count metric still counts the call from
    // tool_call_state alone.
    const skillMetric = result.metricValues.find(
      (m) => m.metricId === 'devin:invocations:skill:root_only',
    );
    expect(skillMetric?.value).toBe(1);
    expect(skillMetric?.exact).toBe(true);
  });

  it('sets configurationSnapshot.temporalRole to runtime for a session with components', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    expect(result.configurationSnapshot.temporalRole).toBe('runtime');
  });

  it('reports complete completeness for skill/tool/agent when components are present', () => {
    const result = DevinTransformer.transform(componentsBundle, defaultContext);
    expect(result.configurationSnapshot.completeness.skill).toBe('complete');
    expect(result.configurationSnapshot.completeness.tool).toBe('complete');
    expect(result.configurationSnapshot.completeness.agent).toBe('complete');
  });

  it('produces stable componentIds across two runs of the same bundle', () => {
    const first = DevinTransformer.transform(componentsBundle, defaultContext);
    const second = DevinTransformer.transform(componentsBundle, defaultContext);
    expect(first.componentSummaries.map((c) => c.componentId).sort()).toEqual(
      second.componentSummaries.map((c) => c.componentId).sort(),
    );
  });
});
