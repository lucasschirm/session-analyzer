import { describe, expect, it } from 'vitest';
import {
  createEmptySession,
  detectFormat,
  isAgentOrSkill,
  isAgentTool,
  isReadTool,
  isSkillTool,
  isWriteTool,
  parseAgenticPi,
  parseAntigravity,
  parseClaudeCode,
  parseLocalRunner,
  parseMCP,
  parseOpenCodeCodex,
  parseSession,
} from '../../src/workers/session-parser.worker';

describe('Session Parser - Format Detection', () => {
  it('should detect Claude Code format from user/assistant turn records', () => {
    const content = `{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": "hi"}}
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": []}}`;
    expect(detectFormat(content)).toBe('claude');
  });

  it('should detect Claude Code format from CLI bookkeeping lines', () => {
    const content = `{"type": "last-prompt", "leafUuid": "l1", "sessionId": "s1"}
{"type": "permission-mode", "permissionMode": "auto", "sessionId": "s1"}`;
    expect(detectFormat(content)).toBe('claude');
  });

  it('should detect Agentic Pi format', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789"}
{"type": "usage_snapshot", "tokens": {"input": 100}}`;
    expect(detectFormat(content)).toBe('agentic_pi');
  });

  it('should detect Antigravity format', () => {
    const content = `[{"event": "context_compaction", "tokens_saved": 100}]`;
    expect(detectFormat(content)).toBe('antigravity');
  });

  it('should detect OpenCode/Codex format', () => {
    const content = `{"action": "user_command", "text": "Format code"}
{"action": "cli_exec", "command": "prettier --write ."}`;
    expect(detectFormat(content)).toBe('opencode_codex');
  });

  it('should detect MCP format from a single JSON-RPC message', () => {
    const content = `{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "test"}}`;
    expect(detectFormat(content)).toBe('mcp');
  });

  it('should detect MCP format from multi-line JSON-RPC logs', () => {
    const content = `{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "serve_rest_api_tool"}}
{"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "ok"}]}}`;
    expect(detectFormat(content)).toBe('mcp');
  });

  it('should detect MCP format from a JSON-RPC array', () => {
    const content = `[{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "x"}}]`;
    expect(detectFormat(content)).toBe('mcp');
  });

  it('should detect Local Runner format', () => {
    const content = `{"model": "qwen2.5-coder", "prompt_eval_count": 1024, "eval_count": 256}`;
    expect(detectFormat(content)).toBe('local_runner');
  });

  it('should return unknown for unrecognized format', () => {
    expect(detectFormat(`{"unknown": "data"}`)).toBe('unknown');
  });

  it('should return unknown for empty content', () => {
    expect(detectFormat('')).toBe('unknown');
    expect(detectFormat('   \n  ')).toBe('unknown');
  });

  it('should return unknown for invalid JSON', () => {
    expect(detectFormat('not json at all')).toBe('unknown');
  });
});

describe('Session Parser - Claude Code Parser', () => {
  const projectId = 'test-project';

  it('should sum input, cache, and output tokens across assistant turns', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "timestamp": "2026-08-11T10:00:00.000Z", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": [], "usage": {"input_tokens": 2, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 18, "output_tokens": 15}}}
{"type": "assistant", "sessionId": "s1", "uuid": "a2", "timestamp": "2026-08-11T10:00:05.000Z", "message": {"role": "assistant", "content": [], "usage": {"output_tokens": 45}}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.input_tokens).toBe(2);
    expect(result.session.output_tokens).toBe(60);
    expect(result.session.cache_creation_tokens).toBe(100);
    expect(result.session.cache_read_tokens).toBe(18);
    // total_tokens is input + output only - cache tokens stay in their own
    // fields (see the SessionBuilder.finalize comment for why).
    expect(result.session.total_tokens).toBe(62);
    expect(result.session.source).toBe('claude');
    expect(result.session.total_turns).toBe(2);
    expect(result.session.model).toBe('claude-sonnet-5');
    expect(result.session.models).toEqual([
      { model: 'claude-sonnet-5', input_tokens: 2, output_tokens: 60, cache_creation_tokens: 100, cache_read_tokens: 18 },
    ]);
    expect(result.parseErrors.length).toBe(0);
  });

  it('should map tool_use content blocks to executions with file targets', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "src/app.ts"}}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('Read');
    expect(result.session.tool_executions[0].target).toBe('src/app.ts');
    expect(result.session.files_read).toBe(1);
    expect(result.session.files_written).toBe(0);
  });

  it('should mark a tool execution failed when its tool_result reports an error', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "false"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": true, "content": "command failed"}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].success).toBe(false);
  });

  it('should turn text content blocks into transcript messages', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello **world**"}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.messages.length).toBe(1);
    expect(result.session.messages[0].role).toBe('assistant');
    expect(result.session.messages[0].content).toBe('Hello **world**');
    expect(result.session.total_turns).toBe(1);
  });

  it('should count tool-only assistant turns (thinking/tool_use, no text block) as turns without producing transcript messages', () => {
    // Mirrors a real, fully-agentic Claude Code transcript (e.g. a
    // security-review subagent) where every assistant turn only thinks and
    // calls tools, never emitting a `text` block. `total_turns` must still
    // count each assistant line, while `messages` (which backs the turns
    // drill-down page) legitimately stays empty - there's no bug here, just
    // two metrics measuring different things.
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "let me look"}, {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.ts"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "parentUuid": "a1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}
{"type": "assistant", "sessionId": "s1", "uuid": "a2", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "now check b"}, {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "b.ts"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u2", "parentUuid": "a2", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.total_turns).toBe(2);
    expect(result.session.messages.length).toBe(0);
    expect(result.session.events.filter((event) => event.event_type === 'assistant_turn').length).toBe(2);
    expect(result.session.tool_executions.length).toBe(2);
  });

  it('should ignore CLI-injected meta user turns', () => {
    const content = `{"type": "user", "sessionId": "s1", "uuid": "u1", "isMeta": true, "message": {"role": "user", "content": "<local-command-caveat>ignore me</local-command-caveat>"}}
{"type": "user", "sessionId": "s1", "uuid": "u2", "message": {"role": "user", "content": "Fix the bug"}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.messages.length).toBe(1);
    expect(result.session.messages[0].content).toBe('Fix the bug');
  });

  it('should count agents and skills among tool executions', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Agent", "input": {}}, {"type": "tool_use", "id": "t2", "name": "skill_lookup", "input": {}}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.agent_invocations).toBe(2);
  });

  it('should not count TaskCreate/TaskUpdate-style tools as agent/skill invocations', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "TaskCreate", "input": {}}, {"type": "tool_use", "id": "t2", "name": "TaskUpdate", "input": {}}, {"type": "tool_use", "id": "t3", "name": "Agent", "input": {}}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.agent_invocations).toBe(1);
    expect(result.session.tool_executions.length).toBe(3);
  });

  it('should turn compact_boundary system events into context compactions', () => {
    const content = `{"type": "system", "subtype": "compact_boundary", "sessionId": "s1", "uuid": "sys1", "compactMetadata": {"preTokens": 900, "postTokens": 100, "cumulativeDroppedTokens": 800}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.context_compactions).toBe(1);
    expect(result.session.events.some((event) => event.event_type === 'context_compaction')).toBe(true);
  });

  it('should handle parse errors gracefully', () => {
    const content = `invalid json line
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 100}}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0].line).toBe(1);
    expect(result.session.input_tokens).toBe(100);
  });

  it('should use the ai-title event as the session title, overriding the filename', () => {
    const content = `{"type": "ai-title", "aiTitle": "Fix database seeding error in CI for PR #2342", "sessionId": "s1"}
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5}}}`;

    const result = parseClaudeCode(content, projectId, 'fallback-filename.jsonl');

    expect(result.session.title).toBe('Fix database seeding error in CI for PR #2342');
  });

  it('should fall back to the provided title when there is no ai-title event', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5}}}`;

    const result = parseClaudeCode(content, projectId, 'fallback-filename.jsonl');

    expect(result.session.title).toBe('fallback-filename.jsonl');
  });

  it('should record tool_use input as parameters on the tool execution', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "code-review", "args": "--effort high"}}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].parameters).toEqual({
      skill: 'code-review',
      args: '--effort high',
    });
  });

  it('should capture a tool_result string content as the tool execution result', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git show --stat 3e6cc0d93 | cat"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "commit 3e6cc0d9...\\n...", "is_error": false}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].result).toBe('commit 3e6cc0d9...\n...');
    expect(result.session.tool_executions[0].success).toBe(true);
  });

  it('should join text blocks when tool_result content is an array of content blocks', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.ts"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}], "is_error": false}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].result).toBe('line one\nline two');
  });

  it('should JSON-stringify tool_result content that is neither a string nor text blocks', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "image", "source": {"data": "abc"}}], "is_error": false}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].result).toBe(
      JSON.stringify([{ type: 'image', source: { data: 'abc' } }])
    );
  });

  it('should record the tool_result entry uuid as result_uuid, for locating linked follow-up content', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "parentUuid": null, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "code-review"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "parentUuid": "a1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "skill loaded"}]}}
{"type": "assistant", "sessionId": "s1", "uuid": "a2", "parentUuid": "u1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Full skill instructions here."}]}}`;

    const result = parseClaudeCode(content, projectId);

    const execution = result.session.tool_executions[0];
    expect(execution.result_uuid).toBe('u1');

    const linked = result.session.messages.find((message) => message.parent_uuid === execution.result_uuid);
    expect(linked?.content).toBe('Full skill instructions here.');
  });

  it('should leave the result undefined when the tool_result has no content', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": false}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions[0].result).toBeUndefined();
  });

  it('should track cache_miss_reason diagnostics as events', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "diagnostics": {"cache_miss_reason": {"type": "tools_changed", "cache_missed_input_tokens": 310596}}}}`;

    const result = parseClaudeCode(content, projectId);

    const diagnosticEvent = result.session.events.find((event) => event.event_type === 'diagnostic');
    expect(diagnosticEvent).toBeDefined();
    expect(diagnosticEvent?.description).toBe('Cache miss: tools_changed');
    expect(diagnosticEvent?.metadata).toEqual({
      cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 310596 },
    });
  });

  it('should not record a diagnostic event when diagnostics is null', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "diagnostics": null}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.events.some((event) => event.event_type === 'diagnostic')).toBe(false);
  });

  it('should carry the line uuid and parentUuid onto transcript messages', () => {
    const content = `{"type": "user", "sessionId": "s1", "uuid": "u1", "parentUuid": null, "message": {"role": "user", "content": "Fix the bug"}}
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "parentUuid": "u1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixed it."}]}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.messages[0].uuid).toBe('u1');
    expect(result.session.messages[0].parent_uuid).toBeUndefined();
    expect(result.session.messages[1].uuid).toBe('a1');
    expect(result.session.messages[1].parent_uuid).toBe('u1');
  });

  it('should track task_reminder attachments, deduping by id across snapshots', () => {
    const content = `{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att1", "timestamp": "2026-08-12T10:00:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "in_progress", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "pending", "blocks": [], "blockedBy": []}]}}
{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att2", "timestamp": "2026-08-12T10:05:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "completed", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "in_progress", "blocks": [], "blockedBy": []}]}}
{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att3", "timestamp": "2026-08-12T10:08:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "completed", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "completed", "blocks": [], "blockedBy": []}]}}`;

    const result = parseClaudeCode(content, projectId);

    // Deduped to 2 tasks (not 6, one per raw snapshot line).
    expect(result.session.tasks.length).toBe(2);

    const task1 = result.session.tasks.find((t) => t.id === '1')!;
    expect(task1.subject).toBe('Write parser');
    expect(task1.status).toBe('completed');
    expect(task1.first_seen_at).toBe(new Date('2026-08-12T10:00:00.000Z').getTime());
    // Completed as of the SECOND snapshot (10:05), not the third.
    expect(task1.completed_at).toBe(new Date('2026-08-12T10:05:00.000Z').getTime());

    const task2 = result.session.tasks.find((t) => t.id === '2')!;
    expect(task2.status).toBe('completed');
    expect(task2.completed_at).toBe(new Date('2026-08-12T10:08:00.000Z').getTime());
  });

  it('should not track tasks from non-task_reminder attachments', () => {
    const content = `{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att1", "attachment": {"type": "hook_success", "hookName": "SessionStart:startup"}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tasks.length).toBe(0);
  });
});

describe('Session Parser - Agentic Pi Parser', () => {
  const projectId = 'test-project';

  it('should extract exact tokens and cost from usage_snapshot', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789", "cwd": "/workspace"}
{"type": "message_update", "role": "user", "content": "Add API route"}
{"type": "usage_snapshot", "tokens": {"input": 4500, "output": 1200}, "cost_usd": 0.045}`;

    const result = parseAgenticPi(content, projectId);

    expect(result.session.input_tokens).toBe(4500);
    expect(result.session.output_tokens).toBe(1200);
    expect(result.session.cost_usd).toBe(0.045);
    expect(result.session.source).toBe('agentic_pi');
    expect(result.session.total_turns).toBe(1);
  });

  it('should map tool_execution_start events including writes', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789"}
{"type": "tool_execution_start", "tool": "file_write", "target": "api.controller.ts"}
{"type": "usage_snapshot", "tokens": {"input": 100, "output": 50}}`;

    const result = parseAgenticPi(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('file_write');
    expect(result.session.tool_executions[0].target).toBe('api.controller.ts');
    expect(result.session.files_written).toBe(1);
  });

  it('should record transcript messages from message_update events', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789"}
{"type": "message_update", "role": "user", "content": "Add a restful API route"}
{"type": "message_update", "role": "assistant", "content": "Creating the controller now."}`;

    const result = parseAgenticPi(content, projectId);

    expect(result.session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(result.session.total_turns).toBe(2);
  });
});

describe('Session Parser - Antigravity Parser', () => {
  const projectId = 'test-project';

  const sample = `[
    {"timestamp": "2026-08-11T12:00:00Z", "event": "tool_exec", "tool": "bash", "cmd": "npm run build"},
    {"timestamp": "2026-08-11T12:05:00Z", "event": "file_write", "file": "dist/main.js"},
    {"timestamp": "2026-08-11T12:10:00Z", "event": "context_compaction", "tokens_saved": 15000, "trigger": "threshold_reached"},
    {"timestamp": "2026-08-11T12:12:00Z", "event": "request-review", "policy": "auto_approve"}
  ]`;

  it('should parse the sample Antigravity JSON array', () => {
    const result = parseAntigravity(sample, projectId);

    expect(result.session.source).toBe('antigravity');
    expect(result.session.tool_executions.length).toBe(2);
    expect(result.session.files_written).toBe(1);
    expect(result.session.context_compactions).toBe(1);
    expect(result.session.started_at).toBe(new Date('2026-08-11T12:00:00Z').getTime());
    expect(result.session.ended_at).toBe(new Date('2026-08-11T12:12:00Z').getTime());
  });

  it('should track policy overrides', () => {
    const result = parseAntigravity(sample, projectId);
    expect(result.session.events.some((event) => event.event_type === 'policy_override')).toBe(true);
  });

  it('should handle invalid JSON', () => {
    const result = parseAntigravity('not valid json', projectId);
    expect(result.parseErrors.length).toBe(1);
  });

  it('should reject non-array payloads', () => {
    const result = parseAntigravity('{"event": "tool_exec"}', projectId);
    expect(result.parseErrors.length).toBe(1);
  });
});

describe('Session Parser - OpenCode/Codex Parser', () => {
  const projectId = 'test-project';

  it('should map CLI formatter commands to formatter tools', () => {
    const content = `{"timestamp": 1691760000, "action": "cli_exec", "command": "prettier --write ."}`;

    const result = parseOpenCodeCodex(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('formatter');
    expect(result.session.started_at).toBe(1691760000 * 1000);
  });

  it('should map non-formatter CLI commands to cli tools', () => {
    const content = `{"timestamp": 1691760005, "action": "cli_exec", "command": "npm run build"}`;

    const result = parseOpenCodeCodex(content, projectId);

    expect(result.session.tool_executions[0].tool_name).toBe('cli');
  });

  it('should track /undo commands and user transcript messages', () => {
    const content = `{"timestamp": 1691760000, "action": "user_command", "text": "Format the codebase"}
{"timestamp": 1691760020, "action": "user_command", "text": "/undo"}`;

    const result = parseOpenCodeCodex(content, projectId);

    expect(result.session.events.some((event) => event.description === '/undo')).toBe(true);
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'Format the codebase',
      '/undo',
    ]);
    expect(result.session.total_turns).toBe(2);
  });
});

describe('Session Parser - MCP Parser', () => {
  const projectId = 'test-project';

  it('should parse CallToolRequest from multi-line JSON-RPC logs', () => {
    const content = `{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "serve_rest_api_tool", "arguments": {"framework": "NestJS"}}}
{"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "Route created successfully."}]}}`;

    const result = parseMCP(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('serve_rest_api_tool');
    expect(result.session.tool_executions[0].success).toBe(true);
    expect(result.session.events.some((event) => event.event_type === 'CallToolRequest')).toBe(true);
    expect(result.session.events.some((event) => event.event_type === 'CallToolResult')).toBe(true);
    expect(result.session.total_turns).toBe(1);
  });

  it('should parse CallToolResult from a single JSON object', () => {
    const content = `{"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "Success"}]}}`;

    const result = parseMCP(content, projectId);

    expect(result.session.events.some((event) => event.event_type === 'CallToolResult')).toBe(true);
  });

  it('should mark tool executions as failed on JSON-RPC error responses', () => {
    const content = `{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "flaky_tool"}}
{"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "boom"}}`;

    const result = parseMCP(content, projectId);

    expect(result.session.tool_executions[0].success).toBe(false);
    expect(result.session.events.some((event) => event.event_type === 'CallToolError')).toBe(true);
  });

  it('should parse JSON-RPC arrays', () => {
    const content = `[{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "tool_a"}}]`;

    const result = parseMCP(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
  });

  it('should report an error for content without JSON-RPC messages', () => {
    const result = parseMCP('nothing parseable', projectId);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });
});

describe('Session Parser - Local Runner Parser', () => {
  const projectId = 'test-project';

  it('should parse local runner inference logs', () => {
    const content = `{"timestamp": "2026-08-11T12:45:00Z", "model": "qwen2.5-coder", "prompt_eval_count": 1024, "eval_count": 256, "eval_duration": 4500000000}`;

    const result = parseLocalRunner(content, projectId);

    expect(result.session.input_tokens).toBe(1024);
    expect(result.session.output_tokens).toBe(256);
    expect(result.session.model).toBe('qwen2.5-coder');
    expect(result.session.total_turns).toBe(1);
  });

  it('should track hardware warnings', () => {
    const content = `{"timestamp": "2026-08-11T12:46:00Z", "model": "gemma-2-9b", "warning": "VRAM allocation constraint near limit", "vram_used_mb": 7900}`;

    const result = parseLocalRunner(content, projectId);

    expect(result.session.events.some((event) => event.event_type === 'warning')).toBe(true);
  });
});

describe('Session Parser - parseSession router', () => {
  it('should route Claude payloads and apply the provided title', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5}}}`;

    const result = parseSession(content, 'proj-1', 'claude-session.jsonl');

    expect(result.session.source).toBe('claude');
    expect(result.session.title).toBe('claude-session.jsonl');
    expect(result.session.project_id).toBe('proj-1');
  });

  it('should return an empty session with errors for unknown formats', () => {
    const result = parseSession('{"foo": 1}', 'proj-1', 'weird.json');

    expect(result.session.total_tokens).toBe(0);
    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0].message).toContain('Unknown format');
  });
});

describe('Session Parser - tool classification helpers', () => {
  it('should classify read tools', () => {
    expect(isReadTool('read_file')).toBe(true);
    expect(isReadTool('grep_search')).toBe(true);
    expect(isReadTool('file_write')).toBe(false);
  });

  it('should classify write tools', () => {
    expect(isWriteTool('file_write')).toBe(true);
    expect(isWriteTool('edit')).toBe(true);
    expect(isWriteTool('create_file')).toBe(true);
    expect(isWriteTool('read_file')).toBe(false);
  });

  it('should classify agent and skill tools', () => {
    expect(isAgentOrSkill('dispatch_agent')).toBe(true);
    expect(isAgentOrSkill('skill_lookup')).toBe(true);
    expect(isAgentOrSkill('Agent')).toBe(true);
    expect(isAgentOrSkill('Skill')).toBe(true);
    expect(isAgentOrSkill('read_file')).toBe(false);
  });

  it('should not classify the TaskCreate/TaskUpdate/TaskGet/TaskList/TaskOutput/TaskStop todo tools as agent/skill', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop']) {
      expect(isAgentOrSkill(name)).toBe(false);
    }
  });

  it('should classify the exact Skill/Agent tool names, and only those', () => {
    expect(isSkillTool('Skill')).toBe(true);
    expect(isSkillTool('skill_lookup')).toBe(false);
    expect(isSkillTool('Agent')).toBe(false);

    expect(isAgentTool('Agent')).toBe(true);
    expect(isAgentTool('dispatch_agent')).toBe(false);
    expect(isAgentTool('Skill')).toBe(false);
  });
});

describe('Session Parser - empty session factory', () => {
  it('should create zeroed sessions with references', () => {
    const session = createEmptySession('proj-x', 'mcp', 'empty.log');

    expect(session.project_id).toBe('proj-x');
    expect(session.source).toBe('mcp');
    expect(session.title).toBe('empty.log');
    expect(session.total_tokens).toBe(0);
    expect(session.tool_executions).toEqual([]);
    expect(session.events).toEqual([]);
    expect(session.messages).toEqual([]);
  });
});
