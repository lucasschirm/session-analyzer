import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SANITIZATION_POLICY,
  redactSecrets,
  SanitizationError,
  type SanitizationPolicy,
  sanitizeJson,
  sanitizeJsonl,
  sanitizeMcpConfig,
} from '../../src/index.js';

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function expectHash(value: unknown): string {
  const str = String(value);
  expect(str).toMatch(/^\[HASH:[a-f0-9]{64}\]$/);
  return str;
}

describe('sanitizeJson', () => {
  it('redacts top-level sensitive fields', () => {
    const input = {
      env: { API_KEY: 'secret-key' },
      password: 'hunter2',
      token: 'abc123',
      accessToken: 'tok-1',
      refreshToken: 'tok-2',
      idToken: 'tok-3',
      apiKey: 'key-1',
      api_key: 'key-2',
      privateKey: '-----BEGIN PRIVATE KEY-----...',
      private_key: '-----BEGIN PRIVATE KEY-----...',
      authorization: 'Bearer secret',
      auth: 'basic',
      bearer: 'bearer-token',
      credential: 'creds',
      credentials: { user: 'u', pass: 'p' },
      clientSecret: 'cs',
      secret: 'shh',
      passwd: 'pw',
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output.env).toEqual({ API_KEY: '[REDACTED]' });
    expect(output.password).toBe('[REDACTED]');
    expect(output.token).toBe('[REDACTED]');
    expect(output.accessToken).toBe('[REDACTED]');
    expect(output.refreshToken).toBe('[REDACTED]');
    expect(output.idToken).toBe('[REDACTED]');
    expect(output.apiKey).toBe('[REDACTED]');
    expect(output.api_key).toBe('[REDACTED]');
    expect(output.privateKey).toBe('[REDACTED]');
    expect(output.private_key).toBe('[REDACTED]');
    expect(output.authorization).toBe('[REDACTED]');
    expect(output.auth).toBe('[REDACTED]');
    expect(output.bearer).toBe('[REDACTED]');
    expect(output.credential).toBe('[REDACTED]');
    expect(output.credentials).toEqual({ user: '[REDACTED]', pass: '[REDACTED]' });
    expect(output.clientSecret).toBe('[REDACTED]');
    expect(output.secret).toBe('[REDACTED]');
    expect(output.passwd).toBe('[REDACTED]');
  });

  it('matches field names case-insensitively', () => {
    const input = {
      Env: { key: 'value' },
      PASSWORD: 'hunter2',
      ApiKey: 'k',
      Authorization: 'Bearer secret',
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output.Env).toEqual({ key: '[REDACTED]' });
    expect(output.PASSWORD).toBe('[REDACTED]');
    expect(output.ApiKey).toBe('[REDACTED]');
    expect(output.Authorization).toBe('[REDACTED]');
  });

  it('redacts kebab-case field names by normalizing separators', () => {
    const input = {
      'api-key': 'secret-value',
      'access-token': 'tok',
      'private-key': 'pk',
      'kebab-unaffected': 'public',
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output['api-key']).toBe('[REDACTED]');
    expect(output['access-token']).toBe('[REDACTED]');
    expect(output['private-key']).toBe('[REDACTED]');
    expect(output['kebab-unaffected']).toBe('public');
  });

  it('handles nested objects and arrays', () => {
    const input = {
      server: {
        env: { key: 'value' },
        token: ['a', 'b'],
        nested: {
          password: 'pw',
        },
      },
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output.server).toEqual({
      env: { key: '[REDACTED]' },
      token: ['[REDACTED]', '[REDACTED]'],
      nested: {
        password: '[REDACTED]',
      },
    });
  });

  it('preserves non-sensitive fields', () => {
    const input = {
      name: 'public',
      count: 42,
      enabled: true,
      nested: {
        description: 'A normal value',
      },
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output).toEqual(input);
  });

  it('removes fields when the remove action is requested', () => {
    const input = { env: { key: 'value' }, public: 'ok' };
    const output = sanitizeJson(input, { action: 'remove' }) as Record<string, unknown>;
    expect(output).not.toHaveProperty('env');
    expect(output.public).toBe('ok');
  });

  it('hashes field values when the hash action is requested', () => {
    const input = { password: 'hunter2', env: { key: 'value' } };
    const output = sanitizeJson(input, { action: 'hash' }) as Record<string, unknown>;

    expectHash(output.password);
    expect(output.password).toBe(`[HASH:${hashString('hunter2')}]`);
    expect(output.env).toEqual({ key: `[HASH:${hashString('value')}]` });
  });

  it('redacts nested env values while preserving keys', () => {
    const input = {
      server: {
        env: {
          AWS_ACCESS_KEY_ID: 'akid',
          AWS_SECRET_ACCESS_KEY: 'secret',
          NESTED: {
            deep: 'value',
          },
        },
      },
    };

    const output = sanitizeJson(input) as Record<string, unknown>;
    const env = (output.server as Record<string, unknown>).env as Record<string, unknown>;
    expect(env.AWS_ACCESS_KEY_ID).toBe('[REDACTED]');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('[REDACTED]');
    expect(env.NESTED).toEqual({ deep: '[REDACTED]' });
  });

  it('respects the maximum JSON depth', () => {
    const input = { a: { b: { c: 'value' } } };
    expect(() => sanitizeJson(input, { maxDepth: 1 })).toThrow(SanitizationError);
    expect(() => sanitizeJson(input, { maxDepth: 1 })).toThrow('Maximum JSON depth of 1 exceeded');
  });

  it('uses the default redaction action (redact) when no action is provided', () => {
    const input = { token: 'secret' };
    const output = sanitizeJson(input) as Record<string, unknown>;
    expect(output.token).toBe('[REDACTED]');
  });

  it('accepts a custom redaction field list through the policy', () => {
    const customPolicy: SanitizationPolicy = {
      version: 1,
      jsonRedactionFields: ['customSecret'],
      stringRedactionPatterns: DEFAULT_SANITIZATION_POLICY.stringRedactionPatterns,
      mcpRedactionRules: DEFAULT_SANITIZATION_POLICY.mcpRedactionRules,
      transcriptCapturePolicy: 'raw',
    };

    const input = { customSecret: 'value', public: 'ok' };
    const output = sanitizeJson(input, { policy: customPolicy }) as Record<string, unknown>;
    expect(output.customSecret).toBe('[REDACTED]');
    expect(output.public).toBe('ok');
  });
});

describe('redactSecrets', () => {
  it('redacts Authorization: Bearer headers', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx.yyy';
    const output = redactSecrets(input);
    expect(output).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts Authorization headers case-insensitively', () => {
    const input = 'authorization: bearer sk-test-token-123';
    const output = redactSecrets(input);
    expect(output).toBe('authorization: bearer [REDACTED]');
  });

  it('redacts credential-bearing URLs', () => {
    const input = 'See https://admin:hunter2@example.com/path for details.';
    const output = redactSecrets(input);
    expect(output).toBe('See https://[CREDENTIALS]@example.com/path for details.');
  });

  it('redacts URLs with a user but no password', () => {
    const input = 'Connect via https://user@example.com first.';
    const output = redactSecrets(input);
    expect(output).toBe('Connect via https://[CREDENTIALS]@example.com first.');
  });

  it('redacts private key blocks', () => {
    const input = `Before use:
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAx...
-----END RSA PRIVATE KEY-----
After use.`;
    const output = redactSecrets(input);
    expect(output).toBe(`Before use:
[PRIVATE KEY REDACTED]
After use.`);
  });

  it('preserves host/path @-mentions that are not userinfo', () => {
    const input = 'Visit https://example.com/@user for updates.';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('redacts URLs with URL-encoded usernames', () => {
    const input = 'See https://user%40domain:pass@example.com/path for details.';
    const output = redactSecrets(input);
    expect(output).toBe('See https://[CREDENTIALS]@example.com/path for details.');
  });

  it('redacts URLs with empty passwords', () => {
    const input = 'See https://user:@example.com for details.';
    const output = redactSecrets(input);
    expect(output).toBe('See https://[CREDENTIALS]@example.com for details.');
  });

  it('redacts URLs with userinfo and no path', () => {
    const input = 'See https://user:pass@example.com for details.';
    const output = redactSecrets(input);
    expect(output).toBe('See https://[CREDENTIALS]@example.com for details.');
  });

  it('does not redact URLs that contain no userinfo', () => {
    const input = 'Visit https://example.com/path for updates.';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('does not redact partial private key blocks', () => {
    const input = '-----BEGIN PRIVATE KEY-----\nsome data';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('does not redact public key blocks', () => {
    const input = '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it('uses only the contract patterns and does not invent heuristics', () => {
    const input = 'My gh_token is ghp_xxxxxxxxxxxxxxxxxxxx and my ssh key is id_ed25519';
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });
});

describe('sanitizeJsonl', () => {
  it('sanitizes JSONL line by line', () => {
    const input = `{"env":{"API_KEY":"secret"}}
{"name":"ok"}`;

    const output = sanitizeJsonl(input);
    expect(output).toBe('{"env":{"API_KEY":"[REDACTED]"}}\n{"name":"ok"}');
  });

  it('preserves empty lines', () => {
    const input = '{"token":"x"}\n\n{"token":"y"}';
    const output = sanitizeJsonl(input);
    expect(output).toBe('{"token":"[REDACTED]"}\n\n{"token":"[REDACTED]"}');
  });

  it('bypasses sanitization when isTranscript is true', () => {
    const input = '{"token":"secret"}\n{"env":{"KEY":"value"}}';
    const output = sanitizeJsonl(input, { isTranscript: true });
    expect(output).toBe(input);
  });

  it('throws SanitizationError for lines that exceed the byte limit', () => {
    const input = '{"token":"secret"}';
    expect(() => sanitizeJsonl(input, { maxLineBytes: 1 })).toThrow(SanitizationError);
    expect(() => sanitizeJsonl(input, { maxLineBytes: 1 })).toThrow(/exceeded 1 bytes/);
  });

  it('throws SanitizationError with a JSON parse code for invalid JSON', () => {
    const input = 'this is not json';
    let caught: SanitizationError | undefined;
    try {
      sanitizeJsonl(input);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.code).toBe('SYNC_JSON_PARSE_FAILED');
  });

  it('respects the maximum JSON depth for each line', () => {
    const input = '{"a":{"b":{"c":"d"}}}';
    expect(() => sanitizeJsonl(input, { maxDepth: 1 })).toThrow(SanitizationError);
  });
});

describe('sanitizeMcpConfig', () => {
  it('redacts per-server env maps', () => {
    const input = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          env: { API_KEY: 'secret', NESTED: { deep: 'value' } },
        },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.filesystem.command).toBe('npx');
    expect(output.mcpServers.filesystem.env).toEqual({
      API_KEY: '[REDACTED]',
      NESTED: { deep: '[REDACTED]' },
    });
  });

  it('removes Authorization headers from MCP server configs', () => {
    const input = {
      mcpServers: {
        github: {
          headers: {
            Authorization: 'Bearer ghp_xxx',
            'Content-Type': 'application/json',
          },
        },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.github.headers).not.toHaveProperty('Authorization');
    expect(output.mcpServers.github.headers).not.toHaveProperty('authorization');
    expect(output.mcpServers.github.headers['Content-Type']).toBe('application/json');
  });

  it('redacts args using string redaction patterns', () => {
    const input = {
      mcpServers: {
        custom: {
          args: [
            'https://user:pass@example.com',
            'Authorization: Bearer token-value',
            'normal-arg',
            '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
          ],
        },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.custom.args).toEqual([
      'https://[CREDENTIALS]@example.com',
      'Authorization: Bearer [REDACTED]',
      'normal-arg',
      '[PRIVATE KEY REDACTED]',
    ]);
  });

  it('applies generic field redaction outside mcpServers', () => {
    const input = {
      mcpServers: {},
      token: 'top-secret',
      apiKey: 'global-key',
    };

    const output = sanitizeMcpConfig(input) as Record<string, unknown>;
    expect(output.token).toBe('[REDACTED]');
    expect(output.apiKey).toBe('[REDACTED]');
  });

  it('preserves non-sensitive MCP server fields', () => {
    const input = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.filesystem.command).toBe('npx');
    expect(output.mcpServers.filesystem.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
    ]);
  });

  it('applies redaction to all mcpServers matching the wildcard', () => {
    const input = {
      mcpServers: {
        a: { env: { KEY: 'a' } },
        b: { env: { KEY: 'b' } },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.a.env).toEqual({ KEY: '[REDACTED]' });
    expect(output.mcpServers.b.env).toEqual({ KEY: '[REDACTED]' });
  });
});

describe('SanitizationError', () => {
  it('exposes a stable sync error code', () => {
    const err = new SanitizationError('SYNC_SANITIZATION_ERROR', 'bad');
    expect(err.code).toBe('SYNC_SANITIZATION_ERROR');
    expect(err.message).toBe('bad');
  });
});
