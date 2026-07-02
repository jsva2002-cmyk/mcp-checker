import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const WINDOW_SECONDS = 60 * 60; // 1 hour
export const RATE_LIMIT_MAX = 10;

let redis: Redis | null | undefined;

// Lazily construct the client so a missing config doesn't crash module load
// (e.g. local dev before Upstash credentials are set up).
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn('[rateLimit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting is disabled.');
    redis = null;
    return redis;
  }

  redis = new Redis({ url, token });
  return redis;
}

export async function checkRateLimit(key: string): Promise<{ allowed: boolean }> {
  const client = getRedis();
  if (!client) {
    // Fail open: an unconfigured or unreachable Redis shouldn't take the app down.
    return { allowed: true };
  }

  try {
    const redisKey = `ratelimit:${key}`;
    const count = await client.incr(redisKey);
    if (count === 1) {
      await client.expire(redisKey, WINDOW_SECONDS);
    }
    return { allowed: count <= RATE_LIMIT_MAX };
  } catch (err) {
    console.error('[rateLimit] Upstash request failed, failing open:', err);
    return { allowed: true };
  }
}

export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const first = forwardedFor?.split(',')[0]?.trim();
  if (first) return first;

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;

  return 'unknown';
}

export function rateLimitResponse(): NextResponse {
  return NextResponse.json(
    { error: `Rate limit exceeded. You can run ${RATE_LIMIT_MAX} checks per hour. Please try again later.` },
    { status: 429 },
  );
}
