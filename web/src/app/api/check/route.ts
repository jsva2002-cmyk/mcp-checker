import { NextRequest, NextResponse } from 'next/server';
import { runLayer1 } from '@/lib/layer1';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rateLimit';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { allowed } = await checkRateLimit(getClientIp(request));
  if (!allowed) {
    return rateLimitResponse();
  }

  let authHeader: string | undefined;

  try {
    const body = await request.json() as { url?: string; authHeader?: string };
    const { url } = body;
    authHeader = typeof body.authHeader === 'string' && body.authHeader.trim() ? body.authHeader.trim() : undefined;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    const report = await runLayer1(url, authHeader);
    return NextResponse.json(report);
  } catch (err) {
    let message = err instanceof Error ? err.message : 'Unknown error';
    // Defense in depth: strip the auth token from the message even though nothing
    // upstream is expected to echo it back — never let it reach the client.
    if (authHeader) message = message.split(authHeader).join('[redacted]');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
