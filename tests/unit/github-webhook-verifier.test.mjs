import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createGitHubPushVerifier,
  WebhookVerificationError,
} from '../../src/security/github-webhook-verifier.mjs';

const SECRET = 'unit-test-only-secret-with-at-least-32-bytes';
const TRUSTED_REPOSITORY_ID = 123456789;
const TRUSTED_REPOSITORY_NAME = 'example-owner/example-repository';
const TRUSTED_BRANCH_REF = 'refs/heads/main';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

function makePayload(overrides = {}) {
  return {
    repository: {
      id: TRUSTED_REPOSITORY_ID,
      full_name: TRUSTED_REPOSITORY_NAME,
      serviceId: 'untrusted-service-id',
      liveUrl: 'https://untrusted.invalid/',
    },
    ref: TRUSTED_BRANCH_REF,
    deleted: false,
    after: COMMIT_SHA,
    ...overrides,
  };
}

function signatureFor(rawBody, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function makeRequest(rawBody, overrides = {}) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const headers = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-github-event': 'push',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': signatureFor(body),
    ...overrides.headers,
  };
  const request = Readable.from([body]);
  request.method = overrides.method ?? 'POST';
  request.headers = headers;
  return request;
}

function makeVerifier(overrides = {}) {
  return createGitHubPushVerifier({
    webhookSecret: SECRET,
    repositoryId: TRUSTED_REPOSITORY_ID,
    repositoryName: TRUSTED_REPOSITORY_NAME,
    branchRef: TRUSTED_BRANCH_REF,
    ...overrides,
  });
}

class InstrumentedChunkedRequest extends EventEmitter {
  constructor(chunks) {
    super();
    this.chunks = [...chunks];
    this.consumedChunks = 0;
    this.paused = false;
    this.method = 'POST';
    this.headers = {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    };
  }

  resume() {
    while (!this.paused && this.chunks.length > 0) {
      const chunk = this.chunks.shift();
      this.consumedChunks++;
      this.emit('data', chunk);
    }
    if (!this.paused) this.emit('end');
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }
}

async function assertRejected(verifier, request, code, statusCode) {
  await assert.rejects(verifier(request), error => {
    assert.ok(error instanceof WebhookVerificationError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test('accepts a correctly signed push and returns only normalized trusted fields', async () => {
  const payload = makePayload();
  const rawBody = Buffer.from(JSON.stringify(payload));
  const deliveryId = randomUUID();
  const request = makeRequest(rawBody, { headers: { 'x-github-delivery': deliveryId } });

  const result = await makeVerifier()(request);

  assert.deepEqual(result, {
    deliveryId,
    repositoryId: TRUSTED_REPOSITORY_ID,
    repositoryName: TRUSTED_REPOSITORY_NAME,
    branchRef: TRUSTED_BRANCH_REF,
    commitSha: COMMIT_SHA,
  });
  assert.equal(Object.hasOwn(result, 'liveUrl'), false);
  assert.equal(Object.hasOwn(result, 'serviceId'), false);
});

test('verifies the exact original bytes before parsing', async () => {
  const rawBody = Buffer.from(`{ "repository": ${JSON.stringify(makePayload().repository)}, "ref":"${TRUSTED_BRANCH_REF}","deleted":false,"after":"${COMMIT_SHA}" }`);
  const request = makeRequest(rawBody);
  request.headers['x-hub-signature-256'] = signatureFor(Buffer.from(JSON.stringify(JSON.parse(rawBody))));

  await assertRejected(makeVerifier(), request, 'invalid_signature', 401);
});

test('rejects a body altered after its signature was generated', async () => {
  const request = makeRequest(Buffer.from(JSON.stringify(makePayload())));
  request.headers['x-hub-signature-256'] = signatureFor(Buffer.from('different body'));

  await assertRejected(makeVerifier(), request, 'invalid_signature', 401);
});

test('rejects missing or malformed signatures', async t => {
  for (const signature of [undefined, 'sha1=abc', 'sha256=not-hex']) {
    await t.test(String(signature), async () => {
      const request = makeRequest(JSON.stringify(makePayload()));
      if (signature === undefined) delete request.headers['x-hub-signature-256'];
      else request.headers['x-hub-signature-256'] = signature;
      await assertRejected(makeVerifier(), request, 'invalid_signature', 401);
    });
  }
});

test('verification errors do not expose the secret, supplied signature, or raw payload', async () => {
  const rawMarker = 'raw-payload-sensitive-marker';
  const suppliedSignature = 'malformed-signature-sensitive-marker';
  const rawBody = Buffer.from(JSON.stringify({ marker: rawMarker }));
  const request = makeRequest(rawBody, {
    headers: { 'x-hub-signature-256': suppliedSignature },
  });

  await assert.rejects(makeVerifier()(request), error => {
    const diagnostic = [error.name, error.message, error.code, error.stack].join('\n');
    assert.equal(diagnostic.includes(SECRET), false);
    assert.equal(diagnostic.includes(suppliedSignature), false);
    assert.equal(diagnostic.includes(rawMarker), false);
    assert.equal(diagnostic.includes(rawBody.toString()), false);
    return error instanceof WebhookVerificationError && error.code === 'invalid_signature';
  });
});

test('rejects non-POST methods and unsupported content types', async t => {
  await t.test('method', async () => {
    const request = makeRequest(JSON.stringify(makePayload()), { method: 'GET' });
    await assertRejected(makeVerifier(), request, 'method_not_allowed', 405);
  });
  await t.test('content type', async () => {
    const request = makeRequest(JSON.stringify(makePayload()), {
      headers: { 'content-type': 'text/plain' },
    });
    await assertRejected(makeVerifier(), request, 'unsupported_content_type', 415);
  });
});

test('rejects oversized payloads before parsing', async () => {
  const rawBody = Buffer.from(JSON.stringify(makePayload()));
  const request = makeRequest(rawBody);

  await assertRejected(makeVerifier({ maxBodyBytes: 32 }), request, 'payload_too_large', 413);
});

test('rejects malformed and mismatched Content-Length values', async t => {
  await t.test('malformed', async () => {
    const request = makeRequest(JSON.stringify(makePayload()), {
      headers: { 'content-length': '12bytes' },
    });
    await assertRejected(makeVerifier(), request, 'invalid_content_length', 400);
  });
  await t.test('mismatched', async () => {
    const body = Buffer.from(JSON.stringify(makePayload()));
    const request = makeRequest(body, {
      headers: { 'content-length': String(body.length + 1) },
    });
    await assertRejected(makeVerifier(), request, 'content_length_mismatch', 400);
  });
});

test('rejects unsupported content encodings', async () => {
  const request = makeRequest(JSON.stringify(makePayload()), {
    headers: { 'content-encoding': 'gzip' },
  });
  await assertRejected(makeVerifier(), request, 'unsupported_content_encoding', 415);
});

test('rejects a request stream that was already consumed', async () => {
  const request = makeRequest(JSON.stringify(makePayload()));
  for await (const _chunk of request) {
    // Simulate middleware consuming the body before the verifier.
  }

  await assertRejected(makeVerifier(), request, 'request_stream_unavailable', 400);
});

test('bounds chunked payload buffering when content length is absent', async () => {
  const request = Readable.from([Buffer.alloc(24, 0x61), Buffer.alloc(24, 0x62)]);
  request.method = 'POST';
  request.headers = {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
  };

  await assertRejected(makeVerifier({ maxBodyBytes: 32 }), request, 'payload_too_large', 413);
});

test('pauses an oversized chunked stream before consuming subsequent chunks', async () => {
  const request = new InstrumentedChunkedRequest([
    Buffer.alloc(24, 0x61),
    Buffer.alloc(24, 0x62),
    Buffer.from('must-not-be-consumed'),
  ]);

  await assertRejected(makeVerifier({ maxBodyBytes: 32 }), request, 'payload_too_large', 413);

  assert.equal(request.paused, true);
  assert.equal(request.consumedChunks, 2);
  assert.equal(request.chunks.length, 1);
});

test('rejects malformed JSON even when its signature is valid', async () => {
  const rawBody = Buffer.from('{not json');
  const request = makeRequest(rawBody);

  await assertRejected(makeVerifier(), request, 'invalid_json', 400);
});

test('rejects non-push events and invalid delivery IDs', async t => {
  await t.test('event', async () => {
    const request = makeRequest(JSON.stringify(makePayload()), {
      headers: { 'x-github-event': 'pull_request' },
    });
    await assertRejected(makeVerifier(), request, 'unsupported_event', 400);
  });
  await t.test('delivery ID', async () => {
    const request = makeRequest(JSON.stringify(makePayload()), {
      headers: { 'x-github-delivery': 'not-a-uuid' },
    });
    await assertRejected(makeVerifier(), request, 'invalid_delivery_id', 400);
  });
});

test('rejects repository ID or exact repository name mismatches', async t => {
  for (const repository of [
    { id: TRUSTED_REPOSITORY_ID + 1, full_name: TRUSTED_REPOSITORY_NAME },
    { id: TRUSTED_REPOSITORY_ID, full_name: 'Example-owner/example-repository' },
  ]) {
    await t.test(JSON.stringify(repository), async () => {
      const request = makeRequest(JSON.stringify(makePayload({ repository })));
      await assertRejected(makeVerifier(), request, 'repository_not_allowed', 403);
    });
  }
});

test('rejects wrong branch, deleted refs, and invalid commit SHAs', async t => {
  const cases = [
    ['branch', { ref: 'refs/heads/other' }, 'branch_not_allowed'],
    ['deleted', { deleted: true }, 'deleted_ref_not_allowed'],
    ['short SHA', { after: COMMIT_SHA.slice(0, -1) }, 'invalid_commit_sha'],
    ['non-hex SHA', { after: 'z'.repeat(40) }, 'invalid_commit_sha'],
    ['all-zero SHA-1', { after: '0'.repeat(40) }, 'invalid_commit_sha'],
    ['all-zero SHA-256', { after: '0'.repeat(64) }, 'invalid_commit_sha'],
  ];

  for (const [label, overrides, code] of cases) {
    await t.test(label, async () => {
      const request = makeRequest(JSON.stringify(makePayload(overrides)));
      await assertRejected(makeVerifier(), request, code, code === 'branch_not_allowed' ? 403 : 400);
    });
  }
});

test('accepts a full 64-character commit SHA', async () => {
  const sha256Commit = 'a'.repeat(64);
  const request = makeRequest(JSON.stringify(makePayload({ after: sha256Commit })));

  const result = await makeVerifier()(request);
  assert.equal(result.commitSha, sha256Commit);
});

test('rejects weak or invalid trusted configuration at creation', () => {
  assert.throws(() => makeVerifier({ webhookSecret: 'short' }), /configuration/);
  assert.throws(() => makeVerifier({ repositoryId: 0 }), /configuration/);
  assert.throws(() => makeVerifier({ repositoryName: 'not-a-full-name' }), /configuration/);
  assert.throws(() => makeVerifier({ branchRef: 'main' }), /configuration/);
  assert.throws(() => makeVerifier({ maxBodyBytes: 0 }), /configuration/);
});
