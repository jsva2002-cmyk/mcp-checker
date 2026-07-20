import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeErrorForCapture } from './posthog';

// Stand-in for posthog.captureException(err, distinctId, extra) — records
// exactly what it was called with so we can assert on it.
function makeCaptureExceptionStub() {
  const calls: unknown[] = [];
  return {
    captureException: (err: unknown) => { calls.push(err); },
    calls,
  };
}

test('captureException never receives a raw auth token embedded in an error message', () => {
  const authHeader = 'Bearer sk-fake-secret-token-12345';
  const err = new Error(`Upstream request failed: Authorization header was "${authHeader}"`);

  const posthog = makeCaptureExceptionStub();

  // This mirrors the fixed call site in check/route.ts:
  //   posthog.captureException(sanitizeErrorForCapture(err, [authHeader]), ...)
  posthog.captureException(sanitizeErrorForCapture(err, [authHeader]));

  const received = posthog.calls[0];
  assert.ok(received instanceof Error);
  assert.ok(
    !received.message.includes(authHeader),
    `captureException received the raw token: ${received.message}`,
  );
  assert.ok(received.message.includes('[redacted]'));
  assert.equal(
    received.message,
    'Upstream request failed: Authorization header was "[redacted]"',
  );
});

test('sanitizeErrorForCapture redacts the secret from the stack trace too', () => {
  const authHeader = 'Bearer sk-fake-secret-token-12345';
  const err = new Error('boom');
  err.stack = `Error: boom\n    at fetch (Authorization: ${authHeader})\n    at runLayer1`;

  const sanitized = sanitizeErrorForCapture(err, [authHeader]) as Error;

  assert.ok(!sanitized.stack?.includes(authHeader));
  assert.ok(sanitized.stack?.includes('[redacted]'));
});

test('sanitizeErrorForCapture redacts secrets from a chained cause', () => {
  const authHeader = 'Bearer sk-fake-secret-token-12345';
  const cause = new Error(`socket hang up while sending ${authHeader}`);
  const err = new Error('request failed', { cause });

  const sanitized = sanitizeErrorForCapture(err, [authHeader]) as Error;

  assert.ok(sanitized.cause instanceof Error);
  assert.ok(!(sanitized.cause as Error).message.includes(authHeader));
  assert.ok((sanitized.cause as Error).message.includes('[redacted]'));
});

test('sanitizeErrorForCapture is a no-op when no secret is present (e.g. no auth header supplied)', () => {
  const err = new Error('server unreachable');
  const sanitized = sanitizeErrorForCapture(err, [undefined]);
  assert.equal(sanitized, err);
});

test('sanitizeErrorForCapture leaves non-Error values untouched unless they are strings', () => {
  const authHeader = 'Bearer sk-fake-secret-token-12345';
  assert.equal(sanitizeErrorForCapture(42, [authHeader]), 42);
  assert.equal(sanitizeErrorForCapture(`leak: ${authHeader}`, [authHeader]), 'leak: [redacted]');
});
