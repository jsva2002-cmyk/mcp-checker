#!/usr/bin/env ts-node

import fs   from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// dotenv.config() only handles UTF-8; Windows editors sometimes save .env as
// UTF-16 LE. Detect by checking for null bytes in odd positions and decode
// accordingly, then hand the parsed string to dotenv.parse().
(function loadDotEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p);
  let content: string;
  if ((raw[0] === 0xFF && raw[1] === 0xFE) || (raw.length >= 4 && raw[3] === 0x00)) {
    // UTF-16 LE: skip the 2-byte BOM (or corrupted BOM) then decode
    content = raw.slice(2).toString('utf16le');
  } else {
    content = raw.toString('utf8');
  }
  const parsed = dotenv.parse(content);
  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] ??= v;
  }
})();

import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// ─── JSON Schema validator (Layer 1 — unchanged) ─────────────────────────────

const JSON_SCHEMA_TYPES = [
  'string', 'number', 'integer', 'boolean', 'null', 'object', 'array',
] as const;

// z.lazy breaks the circular reference for nested JSON Schema properties.
// Typed as ZodType<unknown> to avoid the recursive-type annotation dance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JsonSchemaPropertySchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.union([
      z.enum(JSON_SCHEMA_TYPES),
      z.array(z.enum(JSON_SCHEMA_TYPES)),
    ]).optional(),
    description:          z.string().optional(),
    title:                z.string().optional(),
    enum:                 z.array(z.unknown()).optional(),
    const:                z.unknown().optional(),
    default:              z.unknown().optional(),
    format:               z.string().optional(),
    // string constraints
    minLength:            z.number().int().nonnegative().optional(),
    maxLength:            z.number().int().nonnegative().optional(),
    pattern:              z.string().optional(),
    // number constraints
    minimum:              z.number().optional(),
    maximum:              z.number().optional(),
    exclusiveMinimum:     z.union([z.number(), z.boolean()]).optional(),
    exclusiveMaximum:     z.union([z.number(), z.boolean()]).optional(),
    multipleOf:           z.number().positive().optional(),
    // array constraints
    items:                z.union([JsonSchemaPropertySchema, z.array(JsonSchemaPropertySchema)]).optional(),
    minItems:             z.number().int().nonnegative().optional(),
    maxItems:             z.number().int().nonnegative().optional(),
    uniqueItems:          z.boolean().optional(),
    // object constraints
    properties:           z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required:             z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaPropertySchema]).optional(),
    patternProperties:    z.record(z.string(), JsonSchemaPropertySchema).optional(),
    // composition
    anyOf:       z.array(JsonSchemaPropertySchema).optional(),
    oneOf:       z.array(JsonSchemaPropertySchema).optional(),
    allOf:       z.array(JsonSchemaPropertySchema).optional(),
    not:         JsonSchemaPropertySchema.optional(),
    // references
    $ref:        z.string().optional(),
    $defs:       z.record(z.string(), JsonSchemaPropertySchema).optional(),
    definitions: z.record(z.string(), JsonSchemaPropertySchema).optional(),
  }).passthrough()
);

// MCP spec: a tool's inputSchema must be a JSON Schema Object (type "object")
const ToolInputSchemaValidator = z.object({
  type:       z.literal('object'),
  properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
  required:   z.array(z.string()).optional(),
}).passthrough();

// ─── Types ────────────────────────────────────────────────────────────────────

// Layer 1
interface ToolResult {
  name:         string;
  title?:       string;
  description?: string;
  passed:       boolean;
  errors?:      string[];
}

// Convenience alias for a single tool returned by the MCP client
type McpTool = Awaited<ReturnType<typeof client.listTools>>['tools'][number];

// Layer 2
interface ClarityResult {
  name:    string;
  score:   number;   // 1–10
  verdict: string;   // one-line explanation
}

interface ConfusionPair {
  tool1:  string;
  tool2:  string;
  reason: string;
}

interface SimulationResult {
  request:      string;
  expectedTool: string;
  pickedTool:   string;
  pickedArgs:   Record<string, unknown>;
  correct:      boolean;
}

interface SuggestedFix {
  name:                  string;
  originalDescription:   string;
  suggestedDescription:  string;
}

const CLARITY_FIX_THRESHOLD = 7;

// ─── Layer 1: Schema validation ───────────────────────────────────────────────

function validateSchema(schema: unknown): { passed: boolean; errors?: string[] } {
  const result = ToolInputSchemaValidator.safeParse(schema);
  if (result.success) return { passed: true };

  const errors = result.error.issues.map(issue => {
    const path = issue.path.length
      ? issue.path.map(String).join('.')
      : 'root';
    return `    at .${path}: ${issue.message}`;
  });
  return { passed: false, errors };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

function divider(char = '─', width = 62) {
  console.log(char.repeat(width));
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function step(msg: string) {
  process.stdout.write(`  ${msg}…`);
}

function stepDone(label?: string) {
  console.log(`\r  ${label ?? ''}${' '.repeat(50)}\r  ${label ?? ''}${GREEN}done${RESET}       `);
}

function stepDoneCustom(prefix: string, suffix: string) {
  const pad = ' '.repeat(Math.max(0, 50 - prefix.length - suffix.length));
  process.stdout.write(`\r  ${prefix}${suffix}${pad}\n`);
}

// ─── Layer 2: Zod schemas for Claude's JSON responses ────────────────────────

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

// ─── Layer 2: Prompt rule blocks (shared across Check 1/2/4 prompts) ─────────

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

// ─── Layer 2: AI helpers ──────────────────────────────────────────────────────

function extractJSON(text: string): unknown {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/s);
  return JSON.parse(fenced ? fenced[1].trim() : text.trim());
}

function toolsToPromptText(tools: McpTool[]): string {
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

// ─── Layer 2: Check 1 — Description Clarity ──────────────────────────────────

async function check1Clarity(
  tools: McpTool[],
  anthropic: Anthropic,
): Promise<ClarityResult[]> {
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

// ─── Layer 2: Check 2 — Tool Confusion Detection ─────────────────────────────

async function check2Confusion(
  tools: McpTool[],
  anthropic: Anthropic,
): Promise<ConfusionPair[]> {
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

// ─── Layer 2: Check 3 — Scenario Simulation ──────────────────────────────────

// More tools (or more flagged confusion pairs) means more ways for an agent to
// pick the wrong tool, so sample more scenarios to get reliable coverage.
function scenarioCount(toolCount: number, confusionPairCount: number): number {
  if (toolCount >= 8 || confusionPairCount >= 5) return 12;
  if (toolCount >= 4) return 8;
  return 5;
}

async function check3Simulation(
  tools: McpTool[],
  confusedPairs: ConfusionPair[],
  anthropic: Anthropic,
): Promise<SimulationResult[]> {
  // Phase A: generate scenarios with expected tools
  const count = scenarioCount(tools.length, confusedPairs.length);

  const confusionBlock = confusedPairs.length > 0
    ? `\nThese tool pairs were flagged as easily confused. Include at least one scenario for each pair that is genuinely ambiguous between the two — a realistic request a careless agent might route to the wrong one:\n${confusedPairs.map(p => `• ${p.tool1} vs ${p.tool2}: ${p.reason}`).join('\n')}\n`
    : '';

  const genText = await callClaude(
    anthropic,
    'You generate realistic test scenarios for MCP tools. Respond only with valid JSON.',
    `Given these MCP tools, generate exactly ${count} diverse, realistic user request scenarios.
Each scenario must have a clear single correct tool.
${confusionBlock}
Tools:
${toolsToPromptText(tools)}

Respond with a JSON array of exactly ${count} items:
[{"request":"<user request>","expectedTool":"<tool_name>"}]`,
    Math.max(1024, count * 200),
  );
  const scenarios = ScenariosResponseSchema.parse(extractJSON(genText));

  // Phase B: for each scenario, ask Claude to pick a tool independently.
  // Temperature 0 makes tool selection deterministic so results are stable run to run.
  const toolMenu = tools
    .map(t => `• ${t.name}: ${t.description ?? '(no description)'}`)
    .join('\n');

  const picks = await Promise.all(scenarios.map(s =>
    callClaude(
      anthropic,
      'You are an AI agent selecting MCP tools. Respond only with valid JSON.',
      `Available tools:\n${toolMenu}\n\nUser request: "${s.request}"\n\nWhich tool would you use and what arguments would you pass?\nRespond with JSON: {"tool":"<tool_name>","arguments":{<key>:<value>,...}}`,
      512,
      0,
    ),
  ));

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

// ─── Layer 2: Check 4 — Suggested Fixes for low-clarity tools ────────────────

async function generateFix(
  tool: McpTool,
  clarity: ClarityResult,
  partner: McpTool | undefined,
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
  tools: McpTool[],
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

// ─── Layer 2: orchestrator ────────────────────────────────────────────────────

async function runLayer2Checks(tools: McpTool[], anthropic: Anthropic): Promise<void> {
  console.log();
  divider('═');
  console.log(`${BOLD}  Layer 2 — Behavior Validation${RESET}  ${DIM}(claude-haiku-4-5)${RESET}`);
  divider('═');

  // Clarity and confusion are computed together (before either is printed) so that
  // suggested fixes for low-clarity tools can reference their confusion pair, if any.
  let clarityResults: ClarityResult[] | undefined;
  let clarityErr: string | undefined;
  let confusedPairs: ConfusionPair[] = [];
  let confusionErr: string | undefined;

  const runConfusion = tools.length >= 2;

  step('Analysing clarity + confusion');
  const [clarityOutcome, confusionOutcome] = await Promise.allSettled([
    check1Clarity(tools, anthropic),
    runConfusion ? check2Confusion(tools, anthropic) : Promise.resolve([] as ConfusionPair[]),
  ]);

  if (clarityOutcome.status === 'fulfilled') clarityResults = clarityOutcome.value;
  else clarityErr = clarityOutcome.reason instanceof Error ? clarityOutcome.reason.message : String(clarityOutcome.reason);

  if (confusionOutcome.status === 'fulfilled') confusedPairs = confusionOutcome.value;
  else confusionErr = confusionOutcome.reason instanceof Error ? confusionOutcome.reason.message : String(confusionOutcome.reason);

  let fixes: SuggestedFix[] = [];
  if (clarityResults) {
    try {
      fixes = await check4SuggestedFixes(tools, clarityResults, confusedPairs, anthropic);
    } catch { /* suggested fixes are best-effort; ignore failures */ }
  }
  const fixByName = new Map(fixes.map(f => [f.name, f]));
  stepDoneCustom('Analysing clarity + confusion… ', `${GREEN}done${RESET}`);

  // ── Check 1: Description Clarity ─────────────────────────────────────────
  console.log(`\n  ${BOLD}CHECK 1 · CLARITY ANALYSIS${RESET}\n`);
  divider();
  console.log();

  if (clarityErr) {
    console.log(`  ${RED}Check 1 failed: ${clarityErr}${RESET}\n`);
  } else if (clarityResults) {
    for (let i = 0; i < clarityResults.length; i++) {
      const r     = clarityResults[i];
      const score = Math.round(r.score);
      const color = score >= 8 ? GREEN : score >= 5 ? YELLOW : RED;
      console.log(`  ${BOLD}[${i + 1}/${clarityResults.length}] ${r.name}${RESET}`);
      console.log(`       Clarity: ${color}${BOLD}${score}/10${RESET}  — ${r.verdict}`);
      const fix = fixByName.get(r.name);
      if (fix) {
        console.log(`       ${GREEN}Recommended fix:${RESET} ${fix.suggestedDescription}`);
      }
      console.log();
    }
  }

  // ── Check 2: Tool Confusion Detection ────────────────────────────────────
  divider();
  console.log(`\n  ${BOLD}CHECK 2 · AMBIGUITY ANALYSIS${RESET}\n`);
  divider();
  console.log();

  if (!runConfusion) {
    console.log(`  ${YELLOW}⚠  Only ${tools.length} tool — no pairs to compare.${RESET}\n`);
  } else if (confusionErr) {
    console.log(`  ${RED}Check 2 failed: ${confusionErr}${RESET}\n`);
  } else if (confusedPairs.length === 0) {
    console.log(`  ${GREEN}✓ No confused tool pairs detected.${RESET}\n`);
  } else {
    for (const p of confusedPairs) {
      console.log(`  ${YELLOW}⚠ ${BOLD}${p.tool1}${RESET}${YELLOW} ↔ ${BOLD}${p.tool2}${RESET}`);
      console.log(`    ${p.reason}\n`);
    }
  }

  // ── Check 3: Scenario Simulation ─────────────────────────────────────────
  divider();
  console.log(`\n  ${BOLD}CHECK 3 · COMPATIBILITY TESTING${RESET}\n`);
  divider();
  console.log();

  try {
    const simCount = scenarioCount(tools.length, confusedPairs.length);
    step(`Running scenario simulation (${simCount} tests)`);
    const sims = await check3Simulation(tools, confusedPairs, anthropic);
    stepDoneCustom('Running scenario simulation… ', `${GREEN}done${RESET}`);
    console.log();

    for (let i = 0; i < sims.length; i++) {
      const s     = sims[i];
      const badge = s.correct ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const argsStr = Object.keys(s.pickedArgs).length > 0
        ? JSON.stringify(s.pickedArgs)
        : '{}';

      console.log(`  ${DIM}Scenario ${i + 1}:${RESET} "${truncate(s.request, 78)}"`);
      console.log(`    Expected: ${BOLD}${s.expectedTool}${RESET}  →  Picked: ${BOLD}${s.pickedTool}${RESET}  ${badge}`);
      console.log(`    Args:     ${DIM}${truncate(argsStr, 80)}${RESET}`);
      console.log();
    }

    const correct = sims.filter(s => s.correct).length;
    const total   = sims.length;
    const scoreColor = correct === total ? GREEN : correct >= Math.ceil(total / 2) ? YELLOW : RED;
    console.log(`  ${BOLD}Score: ${scoreColor}${correct}/${total} passed${RESET}\n`);
  } catch (err) {
    console.log(`\r  ${RED}Check 3 failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  divider('═');
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Need a top-level reference so the McpTool alias resolves; the client instance
// used here is immediately replaced inside checkServer — this is type-only.
declare const client: Client;

async function checkServer(url: string, runAi: boolean): Promise<void> {
  // Validate AI prerequisites before spending time on MCP connection
  let anthropic: Anthropic | undefined;
  if (runAi) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(
        `\n  ${RED}Error: ANTHROPIC_API_KEY is not set.` +
        `\n  Add it to a .env file in this directory or export it in your shell.${RESET}\n`,
      );
      process.exitCode = 1;
      return;
    }
    anthropic = new Anthropic({ apiKey });
  }

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const mcpClient = new Client(
    { name: 'mcp-checker', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    divider('═');
    console.log(`${BOLD}  MCP Server Checker${RESET}`);
    console.log(`  Target: ${CYAN}${url}${RESET}`);
    divider('═');
    console.log();

    // ── Connect ──────────────────────────────────────────────────────────────
    process.stdout.write('  Connecting…');
    await mcpClient.connect(transport);
    console.log(`\r  Connecting… ${GREEN}connected${RESET}       `);

    const serverInfo = mcpClient.getServerVersion();
    if (serverInfo) {
      console.log(`  Server: ${BOLD}${serverInfo.name}${RESET} v${serverInfo.version}`);
    }

    const caps = mcpClient.getServerCapabilities();
    if (!caps?.tools) {
      console.log(`\n  ${YELLOW}⚠  Server does not advertise tool support.${RESET}\n`);
      return;
    }

    // ── List tools (paginated) ────────────────────────────────────────────────
    process.stdout.write('  Fetching tools…');

    const tools: Awaited<ReturnType<typeof mcpClient.listTools>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await mcpClient.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    console.log(`\r  Fetching tools… ${tools.length} found          `);
    console.log();
    divider();
    console.log();

    // ── Layer 1: Validate & print each tool ──────────────────────────────────
    const results: ToolResult[] = tools.map(tool => {
      const v = validateSchema(tool.inputSchema);
      return {
        name:        tool.name,
        title:       tool.annotations?.title,
        description: tool.description,
        passed:      v.passed,
        errors:      v.errors,
      };
    });

    for (let i = 0; i < results.length; i++) {
      const r     = results[i];
      const badge = r.passed ? `${GREEN}✓ PASSED${RESET}` : `${RED}✗ FAILED${RESET}`;
      const idx   = `[${i + 1}/${results.length}]`;

      console.log(`  ${BOLD}${idx} ${r.name}${RESET}`);
      if (r.title && r.title !== r.name) {
        console.log(`       Title:  ${r.title}`);
      }
      if (r.description) {
        console.log(`       Desc:   ${truncate(r.description, 100)}`);
      }
      console.log(`       Schema: ${badge}`);
      if (r.errors) {
        r.errors.forEach(e => console.log(`  ${RED}${e}${RESET}`));
      }
      console.log();
    }

    // ── Layer 1: Summary ─────────────────────────────────────────────────────
    divider();
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    console.log(
      `\n  ${BOLD}Layer 1 Summary:${RESET} ${results.length} tool${results.length !== 1 ? 's' : ''} — ` +
      `${GREEN}${passed} passed${RESET}, ` +
      `${failed > 0 ? RED : GREEN}${failed} failed${RESET}\n`
    );
    divider('═');
    console.log();

    if (failed > 0) process.exitCode = 1;

    // ── Layer 2 (optional) ────────────────────────────────────────────────────
    if (runAi && anthropic) {
      await runLayer2Checks(tools as McpTool[], anthropic);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Error: ${msg}${RESET}\n`);
    process.exitCode = 1;
  } finally {
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('mcp-checker')
  .description('Inspect an MCP server: validate protocol schemas and run behavior validation checks')
  .version('1.0.0')
  .argument('<url>', 'MCP server endpoint (Streamable HTTP transport)')
  .option('--ai', 'Run Layer 2 behavior validation checks (requires ANTHROPIC_API_KEY in .env)')
  .action(async (url: string, options: { ai?: boolean }) => {
    // npm consumes --ai as a config flag (npm_config_ai=true) instead of
    // forwarding it to the script, so we check both sources.
    const runAi = Boolean(options.ai) || process.env.npm_config_ai === 'true';
    await checkServer(url, runAi);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
