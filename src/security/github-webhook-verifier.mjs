import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MAX_CONFIGURED_BODY_BYTES = 10_485_760;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class WebhookVerificationError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = 'WebhookVerificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function configurationError() {
  return new TypeError('Invalid GitHub webhook verifier configuration.');
}

function validateConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object') {
    throw configurationError();
  }

  const { webhookSecret, repositoryId, repositoryName, branchRef } = configuration;
  if (typeof webhookSecret !== 'string' || Buffer.byteLength(webhookSecret, 'utf8') < 32) {
    throw configurationError();
  }
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw configurationError();
  }
  if (typeof repositoryName !== 'string' || !REPOSITORY_NAME_PATTERN.test(repositoryName)) {
    throw configurationError();
  }
  if (typeof branchRef !== 'string' || !BRANCH_REF_PATTERN.test(branchRef)) {
    throw configurationError();
  }

  const maxBodyBytes = configuration.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_CONFIGURED_BODY_BYTES) {
    throw configurationError();
  }

  return Object.freeze({
    webhookSecret: Buffer.from(webhookSecret, 'utf8'),
    repositoryId,
    repositoryName,
    branchRef,
    maxBodyBytes,
  });
}

function reject(code, statusCode) {
  throw new WebhookVerificationError(code, statusCode);
}

function getHeader(request, name) {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

async function readRawBody(request, maxBodyBytes, contentLengthHeader) {
  let declaredLength;
  if (contentLengthHeader !== undefined) {
    if (!/^\d+$/.test(contentLengthHeader)) reject('invalid_content_length', 400);
    declaredLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredLength)) reject('invalid_content_length', 400);
    if (declaredLength > maxBodyBytes) {
      request.pause?.();
      request.once('error', () => {});
      reject('payload_too_large', 413);
    }
  }

  return await new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (removeErrorListener = true) => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      if (removeErrorListener) request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup(false);
      request.once('close', () => request.removeListener('error', onError));
      request.pause?.();
      rejectPromise(error);
    };
    const onData = chunk => {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        fail(new WebhookVerificationError('raw_body_unavailable', 400));
        return;
      }

      const chunkByteLength = chunk.byteLength;
      if (chunkByteLength > maxBodyBytes - totalBytes) {
        fail(new WebhookVerificationError('payload_too_large', 413));
        return;
      }
      const bytes = Buffer.from(chunk);
      totalBytes += chunkByteLength;
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      if (declaredLength !== undefined && declaredLength !== totalBytes) {
        fail(new WebhookVerificationError('content_length_mismatch', 400));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };
    const onError = () => fail(new WebhookVerificationError('request_body_unreadable', 400));
    const onAborted = () => fail(new WebhookVerificationError('request_body_unreadable', 400));

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    request.resume?.();
  });
}

function verifySignature(rawBody, signatureHeader, webhookSecret) {
  if (typeof signatureHeader !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) {
    reject('invalid_signature', 401);
  }

  const supplied = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    reject('invalid_signature', 401);
  }
}

function validatePayload(payload, headers, configuration) {
  const deliveryId = getHeader({ headers }, 'x-github-delivery');
  if (!deliveryId || !DELIVERY_ID_PATTERN.test(deliveryId)) {
    reject('invalid_delivery_id', 400);
  }
  if (getHeader({ headers }, 'x-github-event') !== 'push') {
    reject('unsupported_event', 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    reject('invalid_payload', 400);
  }

  const repository = payload.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository) ||
      repository.id !== configuration.repositoryId ||
      repository.full_name !== configuration.repositoryName) {
    reject('repository_not_allowed', 403);
  }
  if (payload.ref !== configuration.branchRef) reject('branch_not_allowed', 403);
  if (payload.deleted !== false) reject('deleted_ref_not_allowed', 400);
  if (typeof payload.after !== 'string' || !COMMIT_SHA_PATTERN.test(payload.after)) {
    reject('invalid_commit_sha', 400);
  }
  if (/^0+$/.test(payload.after)) reject('invalid_commit_sha', 400);

  return Object.freeze({
    deliveryId,
    repositoryId: repository.id,
    repositoryName: repository.full_name,
    branchRef: payload.ref,
    commitSha: payload.after.toLowerCase(),
  });
}

/**
 * Creates a verifier for one trusted repository and branch. The returned
 * function accepts an unconsumed Node.js IncomingMessage and returns only
 * normalized, validated fields; the raw payload is never returned. An HTTP
 * adapter must enforce request/header timeouts and, after a 413 result, close
 * or destroy the connection because the verifier pauses rather than drains an
 * oversized request.
 */
export function createGitHubPushVerifier(configuration) {
  const trusted = validateConfiguration(configuration);

  return async function verifyGitHubPushRequest(request) {
    if (!request || typeof request !== 'object' || !request.headers) {
      reject('invalid_request', 400);
    }
    if (request.readableDidRead === true || request.readableEnded === true ||
        request.readableAborted === true || request.destroyed === true) {
      reject('request_stream_unavailable', 400);
    }
    if (request.method !== 'POST') reject('method_not_allowed', 405);

    const contentType = getHeader(request, 'content-type');
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      reject('unsupported_content_type', 415);
    }
    const contentEncoding = getHeader(request, 'content-encoding');
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      reject('unsupported_content_encoding', 415);
    }

    const rawBody = await readRawBody(
      request,
      trusted.maxBodyBytes,
      getHeader(request, 'content-length'),
    );
    verifySignature(rawBody, getHeader(request, 'x-hub-signature-256'), trusted.webhookSecret);

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      reject('invalid_json', 400);
    }

    return validatePayload(payload, request.headers, trusted);
  };
}
