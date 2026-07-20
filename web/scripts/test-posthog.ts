// Standalone PostHog connectivity check — bypasses the Next.js app and the
// posthog-node SDK entirely, sending a raw HTTP request to the capture
// endpoint so we can see PostHog's actual status code and body.
//
// Usage: npx tsx scripts/test-posthog.ts
// Reads POSTHOG_API_KEY / POSTHOG_HOST from .env.local, falling back to
// .env.preview.local (both are gitignored).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

for (const file of ['.env.local', '.env.preview.local']) {
  const path = resolve(__dirname, '..', file);
  if (existsSync(path)) loadEnv({ path, override: false });
}

const apiKey = process.env.POSTHOG_API_KEY;
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

if (!apiKey) {
  console.error('POSTHOG_API_KEY is not set (checked .env.local, .env.preview.local).');
  process.exit(1);
}

function maskKey(key: string): string {
  return key.length <= 8 ? '***' : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function main(apiKey: string) {
  const url = `${host.replace(/\/+$/, '')}/i/v0/e/`;
  const body = {
    api_key: apiKey,
    event: 'posthog_connectivity_test',
    distinct_id: 'posthog-test-script',
    properties: {
      source: 'test-posthog.ts',
      $lib: 'raw-http-standalone-test',
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`POST ${url}`);
  console.log(`Using key: ${maskKey(apiKey)}`);
  console.log('');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Request failed (network/DNS/TLS error), not an HTTP response:');
    console.error(err);
    process.exit(1);
  }

  const text = await res.text();
  console.log(`Status: ${res.status} ${res.statusText}`);
  console.log('Body:');
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text || '(empty body)');
  }

  if (res.ok) {
    console.log('\nPostHog accepted the event: the API key and host are valid.');
  } else {
    console.log('\nPostHog rejected the event: see status/body above for why.');
  }
}

main(apiKey);
