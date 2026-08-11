/**
 * Session Parser Web Worker
 * Detects payload schema and normalizes data into DashboardSession format
 */

import type {
  DashboardSession,
  ToolExecution,
  SessionEvent,
  ParsedSession,
  ParseError,
} from '../types';

// Message types for worker communication
interface ParseRequest {
  type: 'parse';
  payload: string;
  projectId: string;
}

interface ParseResponse {
  type: 'result';
  result: ParsedSession;
}

type WorkerMessage = ParseRequest;
type WorkerResponse = ParseResponse;

// Generate unique IDs
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ==================== Format Detection ====================

function detectFormat(content: string): string {
  const trimmed = content.trim();
  
  // Try parsing as JSONL (multiple lines)
  const lines = trimmed.split('\n').filter(line => line.trim());
  
  if (lines.length > 1) {
    // Check for Claude Code format (message_start events)
    if (lines.some(line => line.includes('"type":"message_start"'))) {
      return 'claude';
    }
    
    // Check for Agentic Pi format (session type with version)
    if (lines.some(line => line.includes('"type":"session"') && line.includes('"version"'))) {
      return 'agentic_pi';
    }
  }
  
  // Try parsing as single JSON array (Antigravity)
  if (trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        const hasContextCompaction = data.some(
          (item: Record<string, unknown>) => item.event === 'context_compaction'
        );
        if (hasContextCompaction || data.some((item: Record<string, unknown>) => item.event === 'tool_exec')) {
          return 'antigravity';
        }
      }
    } catch {
      // Not valid JSON array
    }
  }
  
  // Try parsing as JSONL for OpenCode/Codex
  if (lines.length >= 1) {
    try {
      const firstLine = JSON.parse(lines[0]);
      if (firstLine.action && (firstLine.action === 'user_command' || firstLine.action === 'cli_exec')) {
        return 'opencode_codex';
      }
    } catch {
      // Not valid JSON
    }
  }
  
  // Check for MCP format (JSON-RPC)
  try {
    const data = JSON.parse(trimmed);
    if (data.jsonrpc === '2.0' && (data.method || data.result)) {
      return 'mcp';
    }
  } catch {
    // Not valid JSON
  }
  
  // Check for Local Runner format (Ollama/vLLM logs)
  try {
    const data = JSON.parse(trimmed);
    if (data.model && (data.prompt_eval_count !== undefined || data.eval_count !== undefined)) {
      return 'local_runner';
    }
  } catch {
    // Not valid JSON
  }
  
  return 'unknown';
}

// ==================== Parsers ====================

function parseClaudeCode(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  let inputTokens = 0;
  let outputTokens = 0;
  let startedAt = Date.now();
  let endedAt = Date.now();
  const toolExecutions: ToolExecution[] = [];
  const events: SessionEvent[] = [];
  
  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      
      if (event.type === 'message_start') {
        const usage = event.message?.usage;
        if (usage) {
          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
        }
        startedAt = Date.now();
      } else if (event.type === 'message_delta') {
        const usage = event.usage;
        if (usage) {
          outputTokens += usage.output_tokens || 0;
        }
        endedAt = Date.now();
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          toolExecutions.push({
            id: generateId(),
            session_id: '', // Will be set later
            timestamp: Date.now(),
            tool_name: block.name || 'unknown',
            tool_type: 'tool_use',
            target: block.input?.path || block.input?.target,
            success: true,
          });
        }
      }
      
      events.push({
        id: generateId(),
        session_id: '',
        timestamp: Date.now(),
        event_type: event.type || 'unknown',
        description: `Claude event: ${event.type}`,
        metadata: event,
      });
    } catch (e) {
      errors.push({
        line: index + 1,
        message: `Failed to parse line: ${(e as Error).message}`,
        raw_data: line.substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: generateId(),
    project_id: projectId,
    source: 'claude',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    tool_executions,
    events,
  };
  
  // Update session references
  toolExecutions.forEach(te => (te.session_id = session.id));
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function parseAgenticPi(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  let sessionId = '';
  let cwd = '';
  let startedAt = Date.now();
  let endedAt = Date.now();
  const toolExecutions: ToolExecution[] = [];
  const events: SessionEvent[] = [];
  
  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      
      if (event.type === 'session') {
        sessionId = event.id || generateId();
        cwd = event.cwd || '';
        startedAt = Date.now();
      } else if (event.type === 'message_update') {
        events.push({
          id: generateId(),
          session_id: '',
          timestamp: Date.now(),
          event_type: 'message_update',
          description: `Message from ${event.role}: ${event.content?.substring(0, 50) || ''}`,
          metadata: event,
        });
      } else if (event.type === 'tool_execution_start') {
        toolExecutions.push({
          id: generateId(),
          session_id: '',
          timestamp: Date.now(),
          tool_name: event.tool || 'unknown',
          tool_type: 'tool_execution',
          target: event.target,
          success: true,
        });
      } else if (event.type === 'usage_snapshot') {
        inputTokens = event.tokens?.input || 0;
        outputTokens = event.tokens?.output || 0;
        costUsd = event.cost_usd;
        endedAt = Date.now();
      }
    } catch (e) {
      errors.push({
        line: index + 1,
        message: `Failed to parse line: ${(e as Error).message}`,
        raw_data: line.substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: sessionId || generateId(),
    project_id: projectId,
    source: 'agentic_pi',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cost_usd: costUsd,
    tool_executions,
    events,
  };
  
  toolExecutions.forEach(te => (te.session_id = session.id));
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function parseAntigravity(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  
  let data: Array<Record<string, unknown>>;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return {
      session: createEmptySession(projectId, 'antigravity'),
      parseErrors: [{ message: `Failed to parse JSON array: ${(e as Error).message}` }],
    };
  }
  
  if (!Array.isArray(data)) {
    return {
      session: createEmptySession(projectId, 'antigravity'),
      parseErrors: [{ message: 'Expected JSON array' }],
    };
  }
  
  let startedAt = Date.now();
  let endedAt = Date.now();
  const toolExecutions: ToolExecution[] = [];
  const events: SessionEvent[] = [];
  
  data.forEach((item) => {
    try {
      const timestamp = item.timestamp 
        ? new Date(item.timestamp as string).getTime() 
        : Date.now();
      
      if (timestamp < startedAt) startedAt = timestamp;
      if (timestamp > endedAt) endedAt = timestamp;
      
      if (item.event === 'tool_exec') {
        toolExecutions.push({
          id: generateId(),
          session_id: '',
          timestamp,
          tool_name: (item.tool as string) || 'unknown',
          tool_type: 'bash',
          target: (item.cmd as string),
          success: true,
        });
      } else if (item.event === 'file_write') {
        toolExecutions.push({
          id: generateId(),
          session_id: '',
          timestamp,
          tool_name: 'file_write',
          tool_type: 'file_system',
          target: (item.file as string),
          success: true,
        });
      } else if (item.event === 'context_compaction') {
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'context_compaction',
          description: `Context compaction: ${(item.tokens_saved as number) || 0} tokens saved`,
          metadata: item,
        });
      }
      
      events.push({
        id: generateId(),
        session_id: '',
        timestamp,
        event_type: item.event as string || 'unknown',
        description: `Event: ${item.event}`,
        metadata: item,
      });
    } catch (e) {
      errors.push({
        message: `Failed to process item: ${(e as Error).message}`,
        raw_data: JSON.stringify(item).substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: generateId(),
    project_id: projectId,
    source: 'antigravity',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    tool_executions,
    events,
  };
  
  toolExecutions.forEach(te => (te.session_id = session.id));
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function parseOpenCodeCodex(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  let startedAt = Date.now();
  let endedAt = Date.now();
  const toolExecutions: ToolExecution[] = [];
  const events: SessionEvent[] = [];
  let undoCount = 0;
  
  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      const timestamp = event.timestamp 
        ? (typeof event.timestamp === 'number' ? event.timestamp * 1000 : new Date(event.timestamp).getTime())
        : Date.now();
      
      if (index === 0) startedAt = timestamp;
      endedAt = timestamp;
      
      if (event.action === 'cli_exec') {
        const command = event.command as string;
        const isFormatter = command.includes('prettier') || command.includes('eslint') || command.includes('format');
        
        toolExecutions.push({
          id: generateId(),
          session_id: '',
          timestamp,
          tool_name: isFormatter ? 'formatter' : 'cli',
          tool_type: 'cli_exec',
          target: command,
          success: true,
        });
      } else if (event.action === 'user_command') {
        const text = event.text as string;
        if (text === '/undo') {
          undoCount++;
        }
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'user_command',
          description: text,
          metadata: event,
        });
      }
    } catch (e) {
      errors.push({
        line: index + 1,
        message: `Failed to parse line: ${(e as Error).message}`,
        raw_data: line.substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: generateId(),
    project_id: projectId,
    source: 'opencode_codex',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    tool_executions,
    events,
  };
  
  toolExecutions.forEach(te => (te.session_id = session.id));
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function parseMCP(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  
  let data: Record<string, unknown> | Array<Record<string, unknown>>;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return {
      session: createEmptySession(projectId, 'mcp'),
      parseErrors: [{ message: `Failed to parse JSON: ${(e as Error).message}` }],
    };
  }
  
  if (!Array.isArray(data)) {
    data = [data];
  }
  
  let startedAt = Date.now();
  let endedAt = Date.now();
  const toolExecutions: ToolExecution[] = [];
  const events: SessionEvent[] = [];
  
  data.forEach((item) => {
    try {
      const timestamp = Date.now();
      
      if (item.method === 'tools/call') {
        const params = item.params as Record<string, unknown>;
        toolExecutions.push({
          id: generateId(),
          session_id: '',
          timestamp,
          tool_name: (params?.name as string) || 'unknown',
          tool_type: 'mcp_call',
          target: JSON.stringify(params?.arguments),
          success: true,
        });
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'CallToolRequest',
          description: `MCP tool call: ${params?.name}`,
          metadata: item,
        });
      } else if (item.result) {
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'CallToolResult',
          description: 'MCP tool result received',
          metadata: item,
        });
      }
    } catch (e) {
      errors.push({
        message: `Failed to process item: ${(e as Error).message}`,
        raw_data: JSON.stringify(item).substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: generateId(),
    project_id: projectId,
    source: 'mcp',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    tool_executions,
    events,
  };
  
  toolExecutions.forEach(te => (te.session_id = session.id));
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function parseLocalRunner(content: string, projectId: string): ParsedSession {
  const errors: ParseError[] = [];
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  let startedAt = Date.now();
  let endedAt = Date.now();
  let model = '';
  let totalPromptEval = 0;
  let totalEval = 0;
  let totalDuration = 0;
  const events: SessionEvent[] = [];
  
  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      
      const timestamp = event.timestamp 
        ? new Date(event.timestamp).getTime()
        : Date.now();
      
      if (index === 0) startedAt = timestamp;
      endedAt = timestamp;
      
      if (event.model) {
        model = event.model as string;
        
        if (event.prompt_eval_count !== undefined) {
          totalPromptEval += event.prompt_eval_count as number;
        }
        if (event.eval_count !== undefined) {
          totalEval += event.eval_count as number;
        }
        if (event.eval_duration !== undefined) {
          totalDuration += event.eval_duration as number;
        }
        
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'model_inference',
          description: `Model: ${event.model}, Prompt evals: ${event.prompt_eval_count || 0}, Evals: ${event.eval_count || 0}`,
          metadata: event,
        });
      }
      
      if (event.warning) {
        events.push({
          id: generateId(),
          session_id: '',
          timestamp,
          event_type: 'warning',
          description: event.warning as string,
          metadata: event,
        });
      }
    } catch (e) {
      errors.push({
        line: index + 1,
        message: `Failed to parse line: ${(e as Error).message}`,
        raw_data: line.substring(0, 100),
      });
    }
  });
  
  const session: DashboardSession = {
    id: generateId(),
    project_id: projectId,
    source: 'local_runner',
    started_at: startedAt,
    ended_at: endedAt,
    input_tokens: totalPromptEval,
    output_tokens: totalEval,
    total_tokens: totalPromptEval + totalEval,
    model,
    tool_executions: [],
    events,
  };
  
  events.forEach(e => (e.session_id = session.id));
  
  return { session, parseErrors: errors };
}

function createEmptySession(projectId: string, source: DashboardSession['source']): DashboardSession {
  const now = Date.now();
  return {
    id: generateId(),
    project_id: projectId,
    source,
    started_at: now,
    ended_at: now,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    tool_executions: [],
    events: [],
  };
}

// ==================== Main Parse Function ====================

export function parseSession(payload: string, projectId: string): ParsedSession {
  const format = detectFormat(payload);
  
  switch (format) {
    case 'claude':
      return parseClaudeCode(payload, projectId);
    case 'agentic_pi':
      return parseAgenticPi(payload, projectId);
    case 'antigravity':
      return parseAntigravity(payload, projectId);
    case 'opencode_codex':
      return parseOpenCodeCodex(payload, projectId);
    case 'mcp':
      return parseMCP(payload, projectId);
    case 'local_runner':
      return parseLocalRunner(payload, projectId);
    default:
      return {
        session: createEmptySession(projectId, 'claude'),
        parseErrors: [{ message: `Unknown format detected. Raw content preview: ${payload.substring(0, 200)}` }],
      };
  }
}

export { detectFormat, parseClaudeCode, parseAgenticPi, parseAntigravity, parseOpenCodeCodex, parseMCP, parseLocalRunner };

// ==================== Worker Message Handler ====================

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { type, payload, projectId } = event.data;
  
  if (type === 'parse') {
    try {
      const result = parseSession(payload, projectId);
      const response: WorkerResponse = {
        type: 'result',
        result,
      };
      self.postMessage(response);
    } catch (error) {
      self.postMessage({
        type: 'result',
        result: {
          session: createEmptySession(projectId, 'claude'),
          parseErrors: [{ message: `Parser error: ${(error as Error).message}` }],
        },
      });
    }
  }
};

export {};
