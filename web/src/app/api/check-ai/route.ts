import { NextRequest, NextResponse } from 'next/server';
import { runLayer2 } from '@/lib/layer2';
import { getAnthropicApiKey } from '@/lib/env';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rateLimit';
import { checkDailyAiCap, dailyAiCapResponse } from '@/lib/dailyAiCap';
import type { ToolInfo } from '@/lib/types';
import { getPostHogClient, distinctIdFromIp } from '@/lib/posthog';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const distinctId = distinctIdFromIp(clientIp);
  const posthog = getPostHogClient();

  const { allowed } = await checkRateLimit(clientIp);
  if (!allowed) {
    posthog.capture({ distinctId, event: 'rate_limit_exceeded', properties: { endpoint: '/api/check-ai' } });
    await posthog.flush();
    return rateLimitResponse();
  }

  const { allowed: dailyCapAllowed } = await checkDailyAiCap();
  if (!dailyCapAllowed) {
    posthog.capture({ distinctId, event: 'daily_ai_cap_exceeded', properties: {} });
    await posthog.flush();
    return dailyAiCapResponse();
  }

  try {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY is not configured. Add it to web/.env.local or the parent .env file.' },
        { status: 500 },
      );
    }

    const body = await request.json() as { tools?: ToolInfo[] };
    const { tools } = body;

    if (!Array.isArray(tools) || tools.length === 0) {
      return NextResponse.json({ error: 'tools array is required and must not be empty' }, { status: 400 });
    }

    posthog.capture({ distinctId, event: 'layer2_validation_started', properties: { tool_count: tools.length } });
    await posthog.flush();

    const report = await runLayer2(tools, apiKey);

    posthog.capture({
      distinctId,
      event: 'layer2_validation_completed',
      properties: {
        tool_count: tools.length,
        scenarios_run: report.simulation.length,
        scenarios_passed: report.simulationScore,
        issues_count: report.verdict.issuesCount,
        ship_ready: report.verdict.shipReady,
      },
    });
    await posthog.flush();

    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    posthog.captureException(err, distinctId, { endpoint: '/api/check-ai' });
    posthog.capture({ distinctId, event: 'layer2_validation_error', properties: { error_message: message } });
    await posthog.flush();
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
