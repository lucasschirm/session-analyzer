import { describe, it, expect, beforeEach } from 'vitest';
import { detectFormat, parseClaudeCode, parseAgenticPi, parseAntigravity, parseOpenCodeCodex, parseMCP, parseLocalRunner } from '../../src/workers/session-parser.worker';

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

  it('should detect MCP format', () => {
    const content = `{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "test"}}`;
    expect(detectFormat(content)).toBe('mcp');
  });

  it('should detect Local Runner format', () => {
    const content = `{"model": "qwen2.5-coder", "prompt_eval_count": 1024, "eval_count": 256}`;
    expect(detectFormat(content)).toBe('local_runner');
  });

  it('should return unknown for unrecognized format', () => {
    const content = `{"unknown": "data"}`;
    expect(detectFormat(content)).toBe('unknown');
  });
});

describe('Session Parser - Claude Code Parser', () => {
  const projectId = 'test-project';

  it('should parse Claude message_start events', () => {
    const content = `{"type": "message_start", "message": {"role": "assistant", "usage": {"input_tokens": 120, "output_tokens": 15}}}
{"type": "message_delta", "usage": {"output_tokens": 45}}`;
    
    const result = parseClaudeCode(content, projectId);
    
    expect(result.session.input_tokens).toBe(120);
    expect(result.session.output_tokens).toBe(60);
    expect(result.session.total_tokens).toBe(180);
    expect(result.session.source).toBe('claude');
    expect(result.parseErrors.length).toBe(0);
  });

  it('should parse tool_use events', () => {
    const content = `{"type": "content_block_start", "content_block": {"type": "tool_use", "name": "read_file", "input": {"path": "src/app.ts"}}}`;
    
    const result = parseClaudeCode(content, projectId);
    
    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('read_file');
    expect(result.session.tool_executions[0].target).toBe('src/app.ts');
  });

  it('should handle parse errors gracefully', () => {
    const content = `invalid json line
{"type": "message_start", "message": {"usage": {"input_tokens": 100}}}`;
    
    const result = parseClaudeCode(content, projectId);
    
    expect(result.parseErrors.length).toBe(1);
    expect(result.session.input_tokens).toBe(100);
  });
});

describe('Session Parser - Agentic Pi Parser', () => {
  const projectId = 'test-project';

  it('should parse Agentic Pi session data', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789", "cwd": "/workspace"}
{"type": "message_update", "role": "user", "content": "Add API route"}
{"type": "usage_snapshot", "tokens": {"input": 4500, "output": 1200}, "cost_usd": 0.045}`;
    
    const result = parseAgenticPi(content, projectId);
    
    expect(result.session.input_tokens).toBe(4500);
    expect(result.session.output_tokens).toBe(1200);
    expect(result.session.cost_usd).toBe(0.045);
    expect(result.session.source).toBe('agentic_pi');
  });

  it('should parse tool_execution_start events', () => {
    const content = `{"type": "session", "version": 3, "id": "pi_789"}
{"type": "tool_execution_start", "tool": "file_write", "target": "api.controller.ts"}
{"type": "usage_snapshot", "tokens": {"input": 100, "output": 50}}`;
    
    const result = parseAgenticPi(content, projectId);
    
    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('file_write');
    expect(result.session.tool_executions[0].target).toBe('api.controller.ts');
  });
});

describe('Session Parser - Antigravity Parser', () => {
  const projectId = 'test-project';

  it('should parse Antigravity JSON array', () => {
    const content = `[
      {"timestamp": "2026-08-11T12:00:00Z", "event": "tool_exec", "tool": "bash", "cmd": "npm run build"},
      {"timestamp": "2026-08-11T12:05:00Z", "event": "file_write", "file": "dist/main.js"},
      {"timestamp": "2026-08-11T12:10:00Z", "event": "context_compaction", "tokens_saved": 15000}
    ]`;
    
    const result = parseAntigravity(content, projectId);
    
    expect(result.session.source).toBe('antigravity');
    expect(result.session.tool_executions.length).toBe(2);
    expect(result.session.events.some(e => e.event_type === 'context_compaction')).toBe(true);
  });

  it('should handle invalid JSON', () => {
    const content = `not valid json`;
    
    const result = parseAntigravity(content, projectId);
    
    expect(result.parseErrors.length).toBe(1);
  });
});

describe('Session Parser - OpenCode/Codex Parser', () => {
  const projectId = 'test-project';

  it('should parse CLI exec commands', () => {
    const content = `{"timestamp": 1691760000, "action": "cli_exec", "command": "prettier --write ."}`;
    
    const result = parseOpenCodeCodex(content, projectId);
    
    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('formatter');
  });

  it('should track /undo commands', () => {
    const content = `{"timestamp": 1691760000, "action": "user_command", "text": "/undo"}`;
    
    const result = parseOpenCodeCodex(content, projectId);
    
    expect(result.session.events.some(e => e.description === '/undo')).toBe(true);
  });
});

describe('Session Parser - MCP Parser', () => {
  const projectId = 'test-project';

  it('should parse CallToolRequest', () => {
    const content = `{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "serve_rest_api_tool", "arguments": {"framework": "NestJS"}}}`;
    
    const result = parseMCP(content, projectId);
    
    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('serve_rest_api_tool');
    expect(result.session.events.some(e => e.event_type === 'CallToolRequest')).toBe(true);
  });

  it('should parse CallToolResult', () => {
    const content = `{"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "Success"}]}}`;
    
    const result = parseMCP(content, projectId);
    
    expect(result.session.events.some(e => e.event_type === 'CallToolResult')).toBe(true);
  });
});

describe('Session Parser - Local Runner Parser', () => {
  const projectId = 'test-project';

  it('should parse local runner logs', () => {
    const content = `{"timestamp": "2026-08-11T12:45:00Z", "model": "qwen2.5-coder", "prompt_eval_count": 1024, "eval_count": 256, "eval_duration": 4500000000}`;
    
    const result = parseLocalRunner(content, projectId);
    
    expect(result.session.input_tokens).toBe(1024);
    expect(result.session.output_tokens).toBe(256);
    expect(result.session.model).toBe('qwen2.5-coder');
  });

  it('should track warnings', () => {
    const content = `{"timestamp": "2026-08-11T12:46:00Z", "model": "gemma-2-9b", "warning": "VRAM allocation constraint near limit", "vram_used_mb": 7900}`;
    
    const result = parseLocalRunner(content, projectId);
    
    expect(result.session.events.some(e => e.event_type === 'warning')).toBe(true);
  });
});
