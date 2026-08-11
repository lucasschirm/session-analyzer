import { describe, expect, it } from 'vitest';
import {
  createEmptySession,
  detectFormat,
  isAgentOrSkill,
  isReadTool,
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
  it('should detect Claude Code format', () => {
    const content = `{"type": "message_start", "message": {"usage": {"input_tokens": 100}}}
{"type": "content_block_start", "content_block": {"type": "tool_use"}}`;
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

  it('should sum tokens from message_start and message_delta events', () => {
    const content = `{"type": "message_start", "message": {"role": "assistant", "usage": {"input_tokens": 120, "output_tokens": 15}}}
{"type": "message_delta", "usage": {"output_tokens": 45}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.input_tokens).toBe(120);
    expect(result.session.output_tokens).toBe(60);
    expect(result.session.total_tokens).toBe(180);
    expect(result.session.source).toBe('claude');
    expect(result.session.total_turns).toBe(1);
    expect(result.parseErrors.length).toBe(0);
  });

  it('should map tool_use content blocks to executions with file targets', () => {
    const content = `{"type": "content_block_start", "content_block": {"type": "tool_use", "name": "read_file", "input": {"path": "src/app.ts"}}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('read_file');
    expect(result.session.tool_executions[0].target).toBe('src/app.ts');
    expect(result.session.files_read).toBe(1);
    expect(result.session.files_written).toBe(0);
  });

  it('should accumulate text deltas into assistant transcript messages', () => {
    const content = `{"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}
{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello "}}
{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "**world**"}}
{"type": "content_block_stop", "index": 0}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.messages.length).toBe(1);
    expect(result.session.messages[0].role).toBe('assistant');
    expect(result.session.messages[0].content).toBe('Hello **world**');
    expect(result.session.total_turns).toBe(1);
  });

  it('should count agents and skills among tool executions', () => {
    const content = `{"type": "content_block_start", "content_block": {"type": "tool_use", "name": "dispatch_agent", "input": {}}}
{"type": "content_block_start", "content_block": {"type": "tool_use", "name": "skill_lookup", "input": {}}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.session.agent_invocations).toBe(2);
  });

  it('should handle parse errors gracefully', () => {
    const content = `invalid json line
{"type": "message_start", "message": {"usage": {"input_tokens": 100}}}`;

    const result = parseClaudeCode(content, projectId);

    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0].line).toBe(1);
    expect(result.session.input_tokens).toBe(100);
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
    const content = `{"type": "message_start", "message": {"usage": {"input_tokens": 10}}}
{"type": "message_delta", "usage": {"output_tokens": 5}}`;

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
    expect(isAgentOrSkill('read_file')).toBe(false);
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
