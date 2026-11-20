import assert from 'node:assert/strict';
import test from 'node:test';

import { isProtectedRepositoryName } from '../../src/security/repository-scope.mjs';

test('denies protected repository components case-insensitively at routing boundaries', () => {
  for (const name of ['owner/Nova', 'SEASHOP/site', 'owner/AI-Agent']) assert.equal(isProtectedRepositoryName(name), true);
  assert.equal(isProtectedRepositoryName('owner/public-site'), false);
});

test('denies configured full repository names and malformed identities', () => {
  assert.equal(isProtectedRepositoryName('owner/private-site', 'other/repo, owner/private-site'), true);
  assert.equal(isProtectedRepositoryName('owner/repo/extra'), true);
});
