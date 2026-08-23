import { describe, expect, it } from 'vitest';

import { validateProjectId } from '../../src/index.js';

describe('validateProjectId', () => {
  it('accepts a valid slug', () => {
    expect(() => validateProjectId('my-project-1')).not.toThrow();
    expect(() => validateProjectId('abc')).not.toThrow();
  });

  it('rejects uppercase letters', () => {
    expect(() => validateProjectId('MyProject')).toThrow();
  });

  it('rejects underscores', () => {
    expect(() => validateProjectId('my_project')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateProjectId('')).toThrow();
  });

  it('rejects the reserved CAS namespace "global"', () => {
    expect(() => validateProjectId('global')).toThrow();
  });

  it('rejects any character outside lowercase letters, digits and hyphen', () => {
    expect(() => validateProjectId('my project')).toThrow();
    expect(() => validateProjectId('my.project')).toThrow();
    expect(() => validateProjectId('my/project')).toThrow();
  });
});
