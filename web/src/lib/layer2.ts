import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ToolInfo, Layer2Report, ClarityResult, ConfusionPair, SimulationResult, SuggestedFix } from './types';

const CLARITY_FIX_THRESHOLD = 7;

// ─── Zod schemas for Claude responses ────────────────────────────────────────

const ClarityResponseSchema = z.array(z.object({
  name:    z.string(),
  score:   z.number(),
  verdict: z.string(),
}));

const ConfusionResponseSchema = z.object({
  confusedPairs: z.array(z.object({
    tool1:  z.string(),
    tool2:  z.string(),
    reason: z.string(),
  })),
});

const ScenariosResponseSchema = z.array(z.object({
  request:      z.string(),
  expectedTool: z.string(),
}));

const ToolPickResponseSchema = z.object({
  tool:      z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const FixResponseSchema = z.object({
  suggestedDescription: z.string(),
});

// ─── Prompt rule blocks (shared across Check 1/2/4 prompts) ──────────────────

const CLARITY_VERDICT_RULES = `Verdict rules:
- Maximum 25 words, one sentence, no semicolons.
- Never join two ideas with "and" — state the single most important problem.
- State the problem directly. Never phrase it as a suggestion or hedge.
- Never use these phrases: "could be clearer", "might benefit from", "it would be helpful if", "consider adding", "may cause confusion", "seems similar".

BAD: "This description could be clearer and more specific about its purpose."
BAD: "Might benefit from more detail about what it returns."
GOOD: "Doesn't specify what format dates should be in — an agent may pass '2026-07-02' or 'July 2, 2026' inconsistently."
GOOD: "Missing any mention of output format — an agent won't know if this returns JSON, markdown, or plain text."`;

const CONFUSION_REASON_RULES = `Reason rules:
- Maximum 30 words, one sentence.
- Name the exact overlap: the specific words, parameter names, or phrases shared by both tools that make them look identical to an AI.
- Never use these phrases: "seem similar", "could confuse", "overlapping", "might be confused".

BAD: "These tools seem similar and could confuse an agent."
BAD: "Both tools have overlapping functionality."
GOOD: "Both take only repoName and both mention 'documentation' — an agent has no signal to distinguish topic-listing from content-retrieval."`;

const SUGGESTED_FIX_RULES = `Rules:
- Write a drop-in replacement description in active voice.
- Maximum 2 sentences.
- No hedging language. No meta-commentary about the description itself.

GOOD: "Retrieves the full markdown content of a specific wiki page. Use this after read_wiki_structure to read a page's content — not to list available topics."`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/s);
  return JSON.parse(fenced ? fenced[1].trim() : text.trim());
}

function toolsToPromptText(tools: ToolInfo[]): string {
  return JSON.stringify(
    tools.map(t => ({
      name:        t.name,
      description: t.description ?? '(no description)',
      inputSchema: t.inputSchema,
    })),
    null, 2,
  );
}

async function callClaude(
  anthropic: Anthropic,
  system: string,
  user: string,
  maxTokens = 1024,
  temperature?: number,
): Promise<string> {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system,
    messages:   [{ role: 'user', content: user }],
    ...(temperature !== undefined ? { temperature } : {}),
  });
  const block = res.content.find(b => b.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

// ─── Check 1: Description Clarity ────────────────────────────────────────────

async function check1Clarity(tools: ToolInfo[], anthropic: Anthropic): Promise<ClarityResult[]> {
  const text = await callClaude(
    anthropic,
    'You are a tool quality evaluator for MCP servers. Respond only with valid JSON — no prose, no markdown.',
    `Evaluate the clarity of these MCP tools for an AI agent.
For each tool, rate its clarity 1–10 and write a one-sentence verdict identifying the specific problem — or, if the score is high, the specific reason it's clear.

${CLARITY_VERDICT_RULES}

Tools:
${toolsToPromptText(tools)}

Respond with a JSON array in the same order as the input:
[{"name":"<tool_name>","score":<1-10>,"verdict":"<one-sentence explanation>"}]`,
  );
  return ClarityResponseSchema.parse(extractJSON(text));
}

// ─── Check 2: Tool Confusion Detection ───────────────────────────────────────

async function check2Confusion(tools: ToolInfo[], anthropic: Anthropic): Promise<ConfusionPair[]> {
  const text = await callClaude(
    anthropic,
    'You detect potential confusion between MCP tools. Respond only with valid JSON.',
    `Review these MCP tools and identify every pair whose descriptions are similar enough that an AI agent might pick the wrong one.

${CONFUSION_REASON_RULES}

Tools:
${toolsToPromptText(tools)}

Respond with JSON:
{"confusedPairs":[{"tool1":"<name>","tool2":"<name>","reason":"<one-sentence explanation>"}]}

If no pairs are confused, return {"confusedPairs":[]}`,
  );
  const parsed = ConfusionResponseSchema.parse(extractJSON(text));
  return parsed.confusedPairs;
}

// ─── Check 3: Scenario Simulation ────────────────────────────────────────────

// More tools (or more flagged confusion pairs) means more ways for an agent to
// pick the wrong tool, so sample more scenarios to get reliable coverage.
function scenarioCount(toolCount: number, confusionPairCount: number): number {
  if (toolCount >= 8 || confusionPairCount >= 5) return 12;
  if (toolCount >= 4) return 8;
  return 5;
}

async function check3Simulation(
  tools: ToolInfo[],
  confusedPairs: ConfusionPair[],
  anthropic: Anthropic,
): Promise<SimulationResult[]> {
  const count = scenarioCount(tools.length, confusedPairs.length);

  const confusionBlock = confusedPairs.length > 0
    ? `\nThese tool pairs were flagged as easily confused. Include at least one scenario for each pair that is genuinely ambiguous between the two — a realistic request a careless agent might route to the wrong one:\n${confusedPairs.map(p => `• ${p.tool1} vs ${p.tool2}: ${p.reason}`).join('\n')}\n`
    : '';

  const genText = await callClaude(
    anthropic,
    'You generate realistic test scenarios for MCP tools. Respond only with valid JSON.',
    `Given these MCP tools, generate exactly ${count} diverse, realistic user request scenarios. Each scenario must have a clear single correct tool.
${confusionBlock}
Tools:
${toolsToPromptText(tools)}

Respond with a JSON array of exactly ${count} items:
[{"request":"<user request>","expectedTool":"<tool_name>"}]`,
    Math.max(1024, count * 200),
  );
  const scenarios = ScenariosResponseSchema.parse(extractJSON(genText));

  const toolMenu = tools
    .map(t => `• ${t.name}: ${t.description ?? '(no description)'}`)
    .join('\n');

  // Temperature 0 makes tool selection deterministic so results are stable run to run.
  const picks = await Promise.all(
    scenarios.map(s =>
      callClaude(
        anthropic,
        'You are an AI agent selecting MCP tools. Respond only with valid JSON.',
        `Available tools:\n${toolMenu}\n\nUser request: "${s.request}"\n\nWhich tool would you use and what arguments would you pass?\nRespond with JSON: {"tool":"<tool_name>","arguments":{<key>:<value>,...}}`,
        512,
        0,
      ),
    ),
  );

  return scenarios.map((s, i) => {
    let pick: z.infer<typeof ToolPickResponseSchema>;
    try {
      pick = ToolPickResponseSchema.parse(extractJSON(picks[i]));
    } catch {
      pick = { tool: '(parse error)', arguments: {} };
    }
    return {
      request:      s.request,
      expectedTool: s.expectedTool,
      pickedTool:   pick.tool,
      pickedArgs:   pick.arguments ?? {},
      correct:      pick.tool === s.expectedTool,
    };
  });
}

// ─── Check 4: Suggested Fixes for low-clarity tools ──────────────────────────

async function generateFix(
  tool: ToolInfo,
  clarity: ClarityResult,
  partner: ToolInfo | undefined,
  confusionReason: string | undefined,
  anthropic: Anthropic,
): Promise<string> {
  const prompt = partner
    ? `Rewrite the description of the MCP tool "${tool.name}" to fix a clarity problem and to eliminate confusion with a similar tool.

Tool to fix:
Name: ${tool.name}
Description: ${tool.description ?? '(no description)'}
Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}

Clarity score: ${clarity.score}/10
Clarity verdict: ${clarity.verdict}

Tool it gets confused with:
Name: ${partner.name}
Description: ${partner.description ?? '(no description)'}
Input schema: ${JSON.stringify(partner.inputSchema, null, 2)}

Reason for confusion: ${confusionReason}

Write a new description for "${tool.name}" ONLY. It must explicitly contrast with "${partner.name}" by name so an AI agent can reliably pick the correct one.

${SUGGESTED_FIX_RULES}

Respond with JSON: {"suggestedDescription":"<new description>"}`
    : `Rewrite the description of the MCP tool "${tool.name}" to fix a clarity problem.

Tool to fix:
Name: ${tool.name}
Description: ${tool.description ?? '(no description)'}
Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}

Clarity score: ${clarity.score}/10
Clarity verdict: ${clarity.verdict}

Write a new description that fixes the issue above so an AI agent reliably knows when to use this tool and what arguments to pass.

${SUGGESTED_FIX_RULES}

Respond with JSON: {"suggestedDescription":"<new description>"}`;

  const text = await callClaude(
    anthropic,
    'You rewrite MCP tool descriptions to make them clearer for AI agents. Respond only with valid JSON — no prose, no markdown.',
    prompt,
    512,
  );
  return FixResponseSchema.parse(extractJSON(text)).suggestedDescription;
}

async function check4SuggestedFixes(
  tools: ToolInfo[],
  clarity: ClarityResult[],
  confusedPairs: ConfusionPair[],
  anthropic: Anthropic,
): Promise<SuggestedFix[]> {
  const lowScoring = clarity.filter(c => Math.round(c.score) < CLARITY_FIX_THRESHOLD);
  if (lowScoring.length === 0) return [];

  const toolByName = new Map(tools.map(t => [t.name, t]));

  const fixes = await Promise.all(lowScoring.map(async c => {
    const tool = toolByName.get(c.name);
    if (!tool) return null;

    const pair = confusedPairs.find(p => p.tool1 === c.name || p.tool2 === c.name);
    const partnerName = pair ? (pair.tool1 === c.name ? pair.tool2 : pair.tool1) : undefined;
    const partner = partnerName ? toolByName.get(partnerName) : undefined;

    const suggestedDescription = await generateFix(tool, c, partner, pair?.reason, anthropic);
    return {
      name:                  c.name,
      originalDescription:   tool.description ?? '(no description)',
      suggestedDescription,
    };
  }));

  return fixes.filter((f): f is SuggestedFix => f !== null);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runLayer2(tools: ToolInfo[], apiKey: string): Promise<Layer2Report> {
  const anthropic = new Anthropic({ apiKey });

  // Clarity + Confusion run in parallel (each is one Claude call)
  const [clarity, confusedPairs] = await Promise.all([
    check1Clarity(tools, anthropic),
    check2Confusion(tools, anthropic),
  ]);

  // Simulation + suggested fixes each depend only on the results above, so run in parallel.
  const [simulation, suggestedFixes] = await Promise.all([
    check3Simulation(tools, confusedPairs, anthropic),
    check4SuggestedFixes(tools, clarity, confusedPairs, anthropic),
  ]);

  return {
    clarity,
    confusedPairs,
    simulation,
    simulationScore: simulation.filter(s => s.correct).length,
    suggestedFixes,
  };
}
