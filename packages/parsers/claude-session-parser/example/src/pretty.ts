import type {
  ClaudeCodeSession,
  McpServerRecord,
  SkillAvailabilityRecord,
  SubagentLaunchRecord,
  ToolAvailabilityRecord,
} from '@lucasschirm/sal-claude-session-parser';

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const fmtNum = (n: number) => n.toLocaleString('en-US');

function fmtTs(ms?: number): string {
  return ms === undefined ? '—' : new Date(ms).toLocaleString();
}

function badge(text: string, cls = 'badge-ghost'): string {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function stat(title: string, value: string | number, desc = ''): string {
  return `
    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-title">${esc(title)}</div>
      <div class="stat-value text-2xl">${esc(value)}</div>
      ${desc ? `<div class="stat-desc">${esc(desc)}</div>` : ''}
    </div>`;
}

function card(title: string, body: string, extraClass = ''): string {
  return `
    <div class="card bg-base-100 shadow ${extraClass}">
      <div class="card-body">
        <h2 class="card-title">${esc(title)}</h2>
        ${body}
      </div>
    </div>`;
}

function table(headers: string[], rows: string[][]): string {
  return `
    <div class="overflow-x-auto max-h-96 overflow-y-auto">
      <table class="table table-sm table-pin-rows">
        <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const byInvocations = <T extends { invocationCount: number }>(a: T, b: T) =>
  b.invocationCount - a.invocationCount;

function toolsTable(tools: ToolAvailabilityRecord[]): string {
  const rows = [...tools]
    .sort(byInvocations)
    .map((t) => [
      `<span class="font-mono">${esc(t.tool)}</span>`,
      fmtNum(t.invocationCount),
      t.alwaysAvailable ? badge('always', 'badge-info') : badge('on-demand'),
      t.mcpServer ? `<span class="font-mono">${esc(t.mcpServer)}</span>` : '—',
    ]);
  return card(
    `Tools (${tools.length})`,
    table(['Tool', 'Invocations', 'Availability', 'MCP server'], rows),
  );
}

function skillsTable(skills: SkillAvailabilityRecord[]): string {
  const rows = [...skills]
    .sort(byInvocations)
    .map((s) => [
      `<span class="font-mono">${esc(s.name)}</span>`,
      esc(s.description ?? '—'),
      fmtNum(s.invocationCount),
      fmtNum(s.attributedTurnCount),
    ]);
  return card(
    `Skills (${skills.length})`,
    table(['Skill', 'Description', 'Invocations', 'Attributed turns'], rows),
  );
}

function agentsTable(session: ClaudeCodeSession): string {
  const rows = session.agents.map((a) => [
    `<span class="font-mono">${esc(a.agentType)}</span>`,
    esc(a.listingDescription ?? '—'),
    fmtNum(a.invocations.length),
    fmtNum(a.attributedTurnCount),
  ]);
  return card(
    `Agents (${session.agents.length})`,
    table(['Agent type', 'Description', 'Invocations', 'Attributed turns'], rows),
  );
}

function subagentsTable(launches: SubagentLaunchRecord[]): string {
  const rows = launches.map((l) => [
    `<span class="font-mono">${esc(l.agentType)}</span>`,
    esc(l.description ?? '—'),
    esc(l.model ?? '—'),
    l.totalTokens !== undefined ? fmtNum(l.totalTokens) : '—',
    fmtTs(l.timestampMs),
  ]);
  return card(
    `Subagent launches (${launches.length})`,
    table(['Agent type', 'Description', 'Model', 'Total tokens', 'Launched at'], rows),
  );
}

function mcpTable(servers: McpServerRecord[]): string {
  const rows = servers.map((m) => [
    `<span class="font-mono">${esc(m.server)}</span>`,
    fmtNum(m.offeredTools.length),
    fmtNum(m.invokedTools.reduce((n, t) => n + t.count, 0)),
    m.pending ? badge('pending', 'badge-warning') : '',
    m.needsAuth ? badge('needs auth', 'badge-error') : '',
  ]);
  return card(
    `MCP servers (${servers.length})`,
    table(['Server', 'Offered tools', 'Tool calls', '', ''], rows),
  );
}

function headerCard(session: ClaudeCodeSession, fileName: string): string {
  const title = session.aiTitle ?? session.slug ?? session.sessionId ?? fileName;
  const meta = [
    session.sessionId && `session ${session.sessionId}`,
    session.cwd,
    session.gitBranch && `⎇ ${session.gitBranch}`,
    session.agentName && `agent ${session.agentName}`,
  ]
    .filter(Boolean)
    .map((m) => `<div class="font-mono text-sm opacity-70">${esc(m)}</div>`)
    .join('');
  const badges = [
    session.isSidechain ? badge('sidechain', 'badge-warning') : '',
    session.agentId ? badge(`subagent ${session.agentId}`, 'badge-secondary') : '',
    ...session.cliVersions.map((v) => badge(`cli ${v}`, 'badge-outline')),
  ].join(' ');
  return `
    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h1 class="card-title text-2xl">${esc(title)}</h1>
        <div class="flex flex-col gap-1">${meta}</div>
        <div class="flex flex-wrap gap-2 mt-1">${badges}</div>
      </div>
    </div>`;
}

export function renderPretty(session: ClaudeCodeSession, fileName: string): string {
  const usage = session.aggregateUsage;
  const invokedTools = session.tools.filter((t) => t.invocationCount > 0).length;
  const invokedSkills = session.skills.filter((s) => s.invocationCount > 0).length;
  const entryTypes = new Map<string, number>();
  for (const e of session.entries) entryTypes.set(e.type, (entryTypes.get(e.type) ?? 0) + 1);

  const sections: string[] = [
    headerCard(session, fileName),
    `<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${stat('Entries', fmtNum(session.entries.length))}
      ${stat('Input tokens', fmtNum(usage.inputTokens))}
      ${stat('Output tokens', fmtNum(usage.outputTokens))}
      ${stat('Cache read', fmtNum(usage.cacheReadTokens))}
      ${stat('Cache created', fmtNum(usage.cacheCreationTokens))}
      ${stat('Tools used', invokedTools, `of ${session.tools.length} available`)}
      ${stat('Skills invoked', invokedSkills, `of ${session.skills.length} listed`)}
      ${stat('Subagents', fmtNum(session.subagentLaunches.length))}
      ${stat('Compactions', fmtNum(session.compactions.length))}
      ${stat('Hook events', fmtNum(session.hooks.length))}
      ${stat('Parse errors', fmtNum(session.parseErrors.length))}
      ${stat('Unknown types', fmtNum(Object.keys(session.unknownTypes).length))}
    </div>`,
  ];

  const modelRows = Object.entries(usage.models).map(([model, u]) => [
    `<span class="font-mono">${esc(model)}</span>`,
    fmtNum(u.inputTokens),
    fmtNum(u.outputTokens),
    fmtNum(u.cacheCreationTokens),
    fmtNum(u.cacheReadTokens),
  ]);
  if (modelRows.length > 0) {
    sections.push(
      card(
        'Token usage by model',
        table(['Model', 'Input', 'Output', 'Cache created', 'Cache read'], modelRows),
      ),
    );
  }

  if (session.tools.length > 0) sections.push(toolsTable(session.tools));
  if (session.skills.length > 0) sections.push(skillsTable(session.skills));
  if (session.agents.length > 0) sections.push(agentsTable(session));
  if (session.subagentLaunches.length > 0) sections.push(subagentsTable(session.subagentLaunches));
  if (session.mcpServers.length > 0) sections.push(mcpTable(session.mcpServers));

  if (session.rules.length > 0) {
    sections.push(
      card(
        `Rules (${session.rules.length})`,
        table(
          ['Path', 'Scope', 'Injection status'],
          session.rules.map((r) => [
            `<span class="font-mono">${esc(r.displayPath ?? r.path)}</span>`,
            esc(r.scope),
            badge(
              r.injectionStatus,
              r.injectionStatus === 'injected' ? 'badge-success' : 'badge-ghost',
            ),
          ]),
        ),
      ),
    );
  }

  if (session.hooks.length > 0) {
    sections.push(
      card(
        `Hook events (${session.hooks.length})`,
        table(
          ['Hook', 'Event', 'Outcome', 'Duration', 'At'],
          session.hooks.map((h) => [
            `<span class="font-mono">${esc(h.hookName)}</span>`,
            esc(h.hookEvent),
            badge(h.outcome, h.outcome === 'success' ? 'badge-success' : 'badge-warning'),
            h.durationMs !== undefined ? `${fmtNum(h.durationMs)} ms` : '—',
            fmtTs(h.timestampMs),
          ]),
        ),
      ),
    );
  }

  if (session.compactions.length > 0) {
    sections.push(
      card(
        `Compactions (${session.compactions.length})`,
        table(
          ['Trigger', 'Pre-tokens', 'At'],
          session.compactions.map((c) => [
            esc(c.metadata.trigger ?? '—'),
            c.metadata.preTokens !== undefined ? fmtNum(c.metadata.preTokens) : '—',
            fmtTs(c.timestampMs),
          ]),
        ),
      ),
    );
  }

  if (session.permissionModes.length > 0) {
    sections.push(
      card(
        `Permission mode changes (${session.permissionModes.length})`,
        table(
          ['Mode', 'Line', 'At'],
          session.permissionModes.map((p) => [
            esc(p.mode),
            fmtNum(p.lineNumber),
            fmtTs(p.timestampMs),
          ]),
        ),
      ),
    );
  }

  if (session.prLinks.length > 0) {
    sections.push(
      card(
        `PR links (${session.prLinks.length})`,
        table(
          ['PR', 'Repository', 'At'],
          session.prLinks.map((p) => [
            `<a class="link link-primary" href="${esc(p.prUrl)}">#${fmtNum(p.prNumber)}</a>`,
            esc(p.prRepository),
            fmtTs(p.timestampMs),
          ]),
        ),
      ),
    );
  }

  const typeBadges = [...entryTypes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => badge(`${t} × ${fmtNum(n)}`, 'badge-outline'))
    .join(' ');
  const entryRows = session.entries
    .slice(0, 300)
    .map((e) => [
      fmtNum(e.lineNumber),
      badge(
        e.type,
        e.type === 'assistant'
          ? 'badge-primary'
          : e.type === 'user'
            ? 'badge-secondary'
            : 'badge-ghost',
      ),
      `<span class="font-mono">${'uuid' in e ? esc(e.uuid) : '—'}</span>`,
      fmtTs(
        'timestampMs' in e ? e.timestampMs : 'timestamp' in e ? Date.parse(e.timestamp) : undefined,
      ),
    ]);
  sections.push(
    card(
      `Entries (${fmtNum(session.entries.length)})`,
      `<div class="flex flex-wrap gap-2 mb-3">${typeBadges}</div>` +
        table(['Line', 'Type', 'UUID', 'At'], entryRows) +
        (session.entries.length > 300
          ? `<p class="text-sm opacity-60 mt-2">Showing first 300 of ${fmtNum(session.entries.length)} entries.</p>`
          : ''),
    ),
  );

  if (session.parseErrors.length > 0) {
    sections.push(
      card(
        `Parse errors (${session.parseErrors.length})`,
        table(
          ['Line', 'Code', 'Message', 'Snippet'],
          session.parseErrors.map((e) => [
            e.line !== undefined ? fmtNum(e.line) : '—',
            esc(e.code),
            esc(e.message),
            e.rawSnippet ? `<span class="font-mono">${esc(e.rawSnippet)}</span>` : '—',
          ]),
        ),
        'border border-error',
      ),
    );
  }

  const unknowns = Object.entries(session.unknownTypes);
  if (unknowns.length > 0) {
    sections.push(
      card(
        `Unknown entry types (${unknowns.length})`,
        `<div class="flex flex-wrap gap-2">${unknowns
          .map(([t, n]) => badge(`${esc(t)} × ${fmtNum(n)}`, 'badge-warning'))
          .join('')}</div>`,
      ),
    );
  }

  return sections.join('');
}
