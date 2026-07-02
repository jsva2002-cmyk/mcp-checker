import { NextRequest, NextResponse } from 'next/server';
import { runLayer2 } from '@/lib/layer2';
import { getAnthropicApiKey } from '@/lib/env';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rateLimit';
import type { ToolInfo } from '@/lib/types';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { allowed } = await checkRateLimit(getClientIp(request));
  if (!allowed) {
    return rateLimitResponse();
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

    const report = await runLayer2(tools, apiKey);
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
