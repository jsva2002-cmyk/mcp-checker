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
