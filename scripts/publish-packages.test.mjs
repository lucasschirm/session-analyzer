import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getPublishablePackages,
  isAlreadyPublished,
  publishAllPackages,
  publishPackage,
} from './publish-packages.mjs';

describe('isAlreadyPublished', () => {
  it('detects previously published version errors', () => {
    const err = 'npm error You cannot publish over the previously published versions: 0.2.40.';
    assert.equal(isAlreadyPublished(err), true);
  });

  it('detects EPUBLISHCONFLICT', () => {
    assert.equal(isAlreadyPublished('npm error code EPUBLISHCONFLICT'), true);
  });

  it('detects cannot publish over', () => {
    assert.equal(isAlreadyPublished('cannot publish over existing'), true);
  });

  it('does not match unrelated npm errors', () => {
    assert.equal(isAlreadyPublished('npm error code ENEEDAUTH'), false);
    assert.equal(isAlreadyPublished('npm error code ENOTFOUND'), false);
    assert.equal(isAlreadyPublished(''), false);
  });
});

describe('getPublishablePackages', () => {
  it('discovers workspace packages with version:publish script', () => {
    const pkgs = getPublishablePackages();
    assert.ok(pkgs.length >= 2, 'Expected multiple publishable packages');
    const names = pkgs.map((p) => p.name);
    assert.ok(names.includes('@lucasschirm/claude-session-sync'));
    assert.ok(names.includes('@lucasschirm/devin-session-sync'));
    assert.ok(!names.includes('session-analyzer'), 'Root package should be excluded');
  });
});

describe('publishPackage', () => {
  it('returns published when runner exits with code 0', async () => {
    const pkg = { name: 'test-pkg', version: '1.0.0', dir: '/tmp/test' };
    const runner = () => ({ status: 0, stdout: 'published', stderr: '' });
    const res = await publishPackage(pkg, { runner, maxAttempts: 2, retryDelayMs: 0 });
    assert.equal(res.status, 'published');
  });

  it('returns already-published on conflict without retrying', async () => {
    const pkg = { name: 'test-pkg', version: '1.0.0', dir: '/tmp/test' };
    let calls = 0;
    const runner = () => {
      calls++;
      return {
        status: 1,
        stdout: '',
        stderr: 'You cannot publish over previously published versions: 1.0.0',
      };
    };
    const res = await publishPackage(pkg, { runner, maxAttempts: 2, retryDelayMs: 0 });
    assert.equal(res.status, 'already-published');
    assert.equal(calls, 1, 'Should not retry when version is already published');
  });

  it('retries transient failures and succeeds if second attempt passes', async () => {
    const pkg = { name: 'test-pkg', version: '1.0.0', dir: '/tmp/test' };
    let calls = 0;
    const runner = () => {
      calls++;
      if (calls === 1) return { status: 1, stdout: '', stderr: 'ETIMEDOUT' };
      return { status: 0, stdout: 'published', stderr: '' };
    };
    let slept = 0;
    const sleep = async (ms) => {
      slept += ms;
    };
    const res = await publishPackage(pkg, { runner, maxAttempts: 2, retryDelayMs: 50, sleep });
    assert.equal(res.status, 'published');
    assert.equal(calls, 2);
    assert.equal(slept, 50);
  });

  it('returns failed after maxAttempts are exhausted', async () => {
    const pkg = { name: 'test-pkg', version: '1.0.0', dir: '/tmp/test' };
    let calls = 0;
    const runner = () => {
      calls++;
      return { status: 1, stdout: '', stderr: 'ENEEDAUTH' };
    };
    const res = await publishPackage(pkg, {
      runner,
      maxAttempts: 2,
      retryDelayMs: 0,
      sleep: async () => {},
    });
    assert.equal(res.status, 'failed');
    assert.equal(calls, 2);
  });
});

describe('publishAllPackages', () => {
  it('never skips subsequent packages when a prior package is already published', async () => {
    const pkgs = [
      { name: 'pkg-a', version: '1.0.0', relDir: 'packages/a' },
      { name: 'pkg-b', version: '1.0.0', relDir: 'packages/b' },
    ];
    const runner = (pkg) => {
      if (pkg.name === 'pkg-a') {
        return {
          status: 1,
          stdout: '',
          stderr: 'You cannot publish over previously published versions: 1.0.0',
        };
      }
      return { status: 0, stdout: 'published pkg-b', stderr: '' };
    };
    const { success, results } = await publishAllPackages(pkgs, {
      runner,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    assert.equal(success, true);
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'already-published');
    assert.equal(results[1].status, 'published');
  });

  it('never skips subsequent packages when a prior package fails', async () => {
    const pkgs = [
      { name: 'pkg-a', version: '1.0.0', relDir: 'packages/a' },
      { name: 'pkg-b', version: '1.0.0', relDir: 'packages/b' },
    ];
    let pkgBExecuted = false;
    const runner = (pkg) => {
      if (pkg.name === 'pkg-a') {
        return { status: 1, stdout: '', stderr: 'fatal error' };
      }
      pkgBExecuted = true;
      return { status: 0, stdout: 'published pkg-b', stderr: '' };
    };
    const { success, results, failed } = await publishAllPackages(pkgs, {
      runner,
      maxAttempts: 2,
      retryDelayMs: 0,
      sleep: async () => {},
    });
    assert.equal(pkgBExecuted, true, 'pkg-b must be executed even after pkg-a failure');
    assert.equal(success, false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].name, 'pkg-a');
    assert.equal(results[1].status, 'published');
  });
});
