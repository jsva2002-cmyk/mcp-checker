import { createHash } from 'crypto';
import { PostHog } from 'posthog-node';

let _client: PostHog | undefined;

export function getPostHogClient(): PostHog {
  if (!_client) {
    _client = new PostHog(
      process.env.POSTHOG_API_KEY ?? '',
      {
        host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
        flushAt: 1,
        flushInterval: 0,
        enableExceptionAutocapture: true,
      },
    );
  }
  return _client;
}

export function distinctIdFromIp(ip: string): string {
  const hash = createHash('sha256').update(ip).digest('hex').slice(0, 16);
  return `anon_${hash}`;
}

// posthog.captureException() forwards the raw error (message/stack/cause) to
// PostHog. Secrets like the caller-supplied Authorization header or our own
// API keys can end up in an error message via an upstream client/SDK, so any
// error reaching captureException must go through this first — mirrors the
// redaction already applied to client-facing error messages.
export function sanitizeErrorForCapture(err: unknown, secrets: Array<string | undefined>): unknown {
  const values = secrets.filter((s): s is string => !!s);
  if (values.length === 0) return err;

  const redact = (text: string): string =>
    values.reduce((acc, secret) => acc.split(secret).join('[redacted]'), text);

  if (typeof err === 'string') return redact(err);
  if (!(err instanceof Error)) return err;

  const clean = new Error(redact(err.message));
  clean.name = err.name;
  if (err.stack) clean.stack = redact(err.stack);
  if (err.cause !== undefined) clean.cause = sanitizeErrorForCapture(err.cause, values);
  return clean;
}
