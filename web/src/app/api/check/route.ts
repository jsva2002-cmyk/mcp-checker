import { NextRequest, NextResponse } from 'next/server';
import { runLayer1 } from '@/lib/layer1';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rateLimit';
import { getPostHogClient, distinctIdFromIp, sanitizeErrorForCapture, safePostHogCall } from '@/lib/posthog';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const distinctId = distinctIdFromIp(clientIp);
  const posthog = getPostHogClient();

  const { allowed } = await checkRateLimit(clientIp);
  if (!allowed) {
    await safePostHogCall(async () => {
      posthog.capture({ distinctId, event: 'rate_limit_exceeded', properties: { endpoint: '/api/check' } });
      await posthog.flush();
    });
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

    await safePostHogCall(async () => {
      posthog.capture({ distinctId, event: 'mcp_check_started', properties: { server_url: url, has_auth: !!authHeader } });
      await posthog.flush();
    });

    const report = await runLayer1(url, authHeader);

    const passed = report.results.filter(r => r.schemaPassed).length;
    await safePostHogCall(async () => {
      posthog.capture({
        distinctId,
        event: 'layer1_validation_completed',
        properties: {
          server_url: url,
          tool_count: report.toolCount,
          passed_count: passed,
          failed_count: report.toolCount - passed,
          server_name: report.serverName ?? null,
        },
      });
      await posthog.flush();
    });

    return NextResponse.json(report);
  } catch (err) {
    let message = err instanceof Error ? err.message : 'Unknown error';
    // Defense in depth: strip the auth token from the message even though nothing
    // upstream is expected to echo it back — never let it reach the client.
    if (authHeader) message = message.split(authHeader).join('[redacted]');
    await safePostHogCall(async () => {
      posthog.captureException(sanitizeErrorForCapture(err, [authHeader]), distinctId, { endpoint: '/api/check' });
      posthog.capture({ distinctId, event: 'mcp_check_error', properties: { error_message: message } });
      await posthog.flush();
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
