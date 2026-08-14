import { parseSessionTranscript } from '@lucasschirm/sal-claude-session-parser';
import { describe, expect, it } from 'vitest';
import { toDashboardSession } from '../../../src/lib/claude-to-dashboard';

/**
 * Parity suite for the Claude Code pipeline extraction (spec §6/§7): these
 * cases used to live in `tests/unit/parser.test.ts` exercising the old
 * inline `parseClaudeCode(content, projectId, title)` directly. They now
 * exercise `toDashboardSession(parseSessionTranscript(content), projectId,
 * title)` - the pure `parseSessionTranscript` primitive from
 * `@lucasschirm/sal-claude-session-parser` feeding the new site-side
 * transformer - asserting the exact same `DashboardSession`/`ParsedSession`
 * output on every fixture that used to exercise the old parser.
 */
describe('Session Parser - Claude Code Parser (native pipeline)', () => {
  const projectId = 'test-project';

  it('should sum input, cache, and output tokens across assistant turns', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "timestamp": "2026-08-11T10:00:00.000Z", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": [], "usage": {"input_tokens": 2, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 18, "output_tokens": 15}}}
{"type": "assistant", "sessionId": "s1", "uuid": "a2", "timestamp": "2026-08-11T10:00:05.000Z", "message": {"role": "assistant", "content": [], "usage": {"output_tokens": 45}}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

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
      {
        model: 'claude-sonnet-5',
        input_tokens: 2,
        output_tokens: 60,
        cache_creation_tokens: 100,
        cache_read_tokens: 18,
      },
    ]);
    expect(result.parseErrors.length).toBe(0);
  });

  it('should map tool_use content blocks to executions with file targets', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "src/app.ts"}}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions.length).toBe(1);
    expect(result.session.tool_executions[0].tool_name).toBe('Read');
    expect(result.session.tool_executions[0].target).toBe('src/app.ts');
    expect(result.session.files_read).toBe(1);
    expect(result.session.files_written).toBe(0);
  });

  it('should mark a tool execution failed when its tool_result reports an error', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "false"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": true, "content": "command failed"}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].success).toBe(false);
  });

  it('should turn text content blocks into transcript messages', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello **world**"}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

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

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.total_turns).toBe(2);
    expect(result.session.messages.length).toBe(0);
    expect(
      result.session.events.filter((event) => event.event_type === 'assistant_turn').length,
    ).toBe(2);
    expect(result.session.tool_executions.length).toBe(2);
  });

  it('should ignore CLI-injected meta user turns', () => {
    const content = `{"type": "user", "sessionId": "s1", "uuid": "u1", "isMeta": true, "message": {"role": "user", "content": "<local-command-caveat>ignore me</local-command-caveat>"}}
{"type": "user", "sessionId": "s1", "uuid": "u2", "message": {"role": "user", "content": "Fix the bug"}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.messages.length).toBe(1);
    expect(result.session.messages[0].content).toBe('Fix the bug');
  });

  it('should count agents and skills among tool executions', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Agent", "input": {}}, {"type": "tool_use", "id": "t2", "name": "skill_lookup", "input": {}}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.agent_invocations).toBe(2);
  });

  it('should not count TaskCreate/TaskUpdate-style tools as agent/skill invocations', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "TaskCreate", "input": {}}, {"type": "tool_use", "id": "t2", "name": "TaskUpdate", "input": {}}, {"type": "tool_use", "id": "t3", "name": "Agent", "input": {}}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.agent_invocations).toBe(1);
    expect(result.session.tool_executions.length).toBe(3);
  });

  it('should turn compact_boundary system events into context compactions', () => {
    const content = `{"type": "system", "subtype": "compact_boundary", "sessionId": "s1", "uuid": "sys1", "compactMetadata": {"preTokens": 900, "postTokens": 100, "cumulativeDroppedTokens": 800}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.context_compactions).toBe(1);
    expect(result.session.events.some((event) => event.event_type === 'context_compaction')).toBe(
      true,
    );
  });

  it('should handle parse errors gracefully', () => {
    const content = `invalid json line
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 100}}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0].line).toBe(1);
    expect(result.session.input_tokens).toBe(100);
  });

  it('should use the ai-title event as the session title, overriding the filename', () => {
    const content = `{"type": "ai-title", "aiTitle": "Fix database seeding error in CI for PR #2342", "sessionId": "s1"}
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5}}}`;

    const result = toDashboardSession(
      parseSessionTranscript(content),
      projectId,
      'fallback-filename.jsonl',
    );

    expect(result.session.title).toBe('Fix database seeding error in CI for PR #2342');
  });

  it('should fall back to the provided title when there is no ai-title event', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 5}}}`;

    const result = toDashboardSession(
      parseSessionTranscript(content),
      projectId,
      'fallback-filename.jsonl',
    );

    expect(result.session.title).toBe('fallback-filename.jsonl');
  });

  it('should record tool_use input as parameters on the tool execution', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "code-review", "args": "--effort high"}}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].parameters).toEqual({
      skill: 'code-review',
      args: '--effort high',
    });
  });

  it('should capture a tool_result string content as the tool execution result', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git show --stat 3e6cc0d93 | cat"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "commit 3e6cc0d9...\\n...", "is_error": false}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].result).toBe('commit 3e6cc0d9...\n...');
    expect(result.session.tool_executions[0].success).toBe(true);
  });

  it('should join text blocks when tool_result content is an array of content blocks', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.ts"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}], "is_error": false}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].result).toBe('line one\nline two');
  });

  it('should JSON-stringify tool_result content that is neither a string nor text blocks', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "image", "source": {"data": "abc"}}], "is_error": false}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].result).toBe(
      JSON.stringify([{ type: 'image', source: { data: 'abc' } }]),
    );
  });

  it('should record the tool_result entry uuid as result_uuid, for locating linked follow-up content', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "parentUuid": null, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "code-review"}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "parentUuid": "a1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "skill loaded"}]}}
{"type": "assistant", "sessionId": "s1", "uuid": "a2", "parentUuid": "u1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Full skill instructions here."}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    const execution = result.session.tool_executions[0];
    expect(execution.result_uuid).toBe('u1');

    const linked = result.session.messages.find(
      (message) => message.parent_uuid === execution.result_uuid,
    );
    expect(linked?.content).toBe('Full skill instructions here.');
  });

  it('should leave the result undefined when the tool_result has no content', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}
{"type": "user", "sessionId": "s1", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": false}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tool_executions[0].result).toBeUndefined();
  });

  it('should track cache_miss_reason diagnostics as events', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "diagnostics": {"cache_miss_reason": {"type": "tools_changed", "cache_missed_input_tokens": 310596}}}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    const diagnosticEvent = result.session.events.find(
      (event) => event.event_type === 'diagnostic',
    );
    expect(diagnosticEvent).toBeDefined();
    expect(diagnosticEvent?.description).toBe('Cache miss: tools_changed');
    expect(diagnosticEvent?.metadata).toEqual({
      cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 310596 },
    });
  });

  it('should not record a diagnostic event when diagnostics is null', () => {
    const content = `{"type": "assistant", "sessionId": "s1", "uuid": "a1", "message": {"role": "assistant", "content": [], "diagnostics": null}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.events.some((event) => event.event_type === 'diagnostic')).toBe(false);
  });

  it('should carry the line uuid and parentUuid onto transcript messages', () => {
    const content = `{"type": "user", "sessionId": "s1", "uuid": "u1", "parentUuid": null, "message": {"role": "user", "content": "Fix the bug"}}
{"type": "assistant", "sessionId": "s1", "uuid": "a1", "parentUuid": "u1", "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixed it."}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.messages[0].uuid).toBe('u1');
    expect(result.session.messages[0].parent_uuid).toBeUndefined();
    expect(result.session.messages[1].uuid).toBe('a1');
    expect(result.session.messages[1].parent_uuid).toBe('u1');
  });

  it('should track task_reminder attachments, deduping by id across snapshots', () => {
    const content = `{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att1", "timestamp": "2026-08-12T10:00:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "in_progress", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "pending", "blocks": [], "blockedBy": []}]}}
{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att2", "timestamp": "2026-08-12T10:05:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "completed", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "in_progress", "blocks": [], "blockedBy": []}]}}
{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att3", "timestamp": "2026-08-12T10:08:00.000Z", "attachment": {"type": "task_reminder", "itemCount": 2, "content": [{"id": "1", "subject": "Write parser", "description": "Parse the format", "status": "completed", "blocks": [], "blockedBy": []}, {"id": "2", "subject": "Write tests", "description": "Cover the parser", "status": "completed", "blocks": [], "blockedBy": []}]}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    // Deduped to 2 tasks (not 6, one per raw snapshot line).
    expect(result.session.tasks.length).toBe(2);

    const task1 = result.session.tasks.find((t) => t.id === '1');
    if (!task1) throw new Error('task 1 not found');
    expect(task1.subject).toBe('Write parser');
    expect(task1.status).toBe('completed');
    expect(task1.first_seen_at).toBe(new Date('2026-08-12T10:00:00.000Z').getTime());
    // Completed as of the SECOND snapshot (10:05), not the third.
    expect(task1.completed_at).toBe(new Date('2026-08-12T10:05:00.000Z').getTime());

    const task2 = result.session.tasks.find((t) => t.id === '2');
    if (!task2) throw new Error('task 2 not found');
    expect(task2.status).toBe('completed');
    expect(task2.completed_at).toBe(new Date('2026-08-12T10:08:00.000Z').getTime());
  });

  it('should not track tasks from non-task_reminder attachments', () => {
    const content = `{"parentUuid": null, "type": "attachment", "sessionId": "s1", "uuid": "att1", "attachment": {"type": "hook_success", "hookName": "SessionStart:startup"}}`;

    const result = toDashboardSession(parseSessionTranscript(content), projectId);

    expect(result.session.tasks.length).toBe(0);
  });
});
