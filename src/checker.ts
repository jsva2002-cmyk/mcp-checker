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
import { PostHog } from 'posthog-node';

const posthog = new PostHog(
  process.env.POSTHOG_API_KEY ?? '',
  {
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  },
);

// posthog.captureException() forwards the raw error (message/stack/cause) to
// PostHog. If ANTHROPIC_API_KEY ever ends up embedded in an SDK error message,
// it must be scrubbed before the error reaches PostHog.
function sanitizeErrorForCapture(err: unknown, secrets: Array<string | undefined>): unknown {
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
  tool1:                  string;
  tool2:                  string;
  reason:                 string;
  severity:               'HIGH' | 'LOW';
  confirmedByScenario?:   number; // 1-based index into the simulation results
  confirmedByPickedTool?: string; // tool actually picked in that scenario
}

// Shape returned by Check 2 before simulation results are known to rank severity.
type RawConfusionPair = Pick<ConfusionPair, 'tool1' | 'tool2' | 'reason'>;

interface SimulationResult {
  request:      string;
  expectedTool: string;
  pickedTool:   string;
  pickedArgs:   Record<string, unknown>;
  correct:      boolean;
  argWarning?:    boolean;              // right tool picked, but arguments look wrong
  argIssue?:      string;               // one-line reason when argWarning is true
  argIssueType?:  'schema' | 'value';   // schema = programmatic Zod validation; value = LLM heuristic
}

interface ScenarioFailureContext {
  scenarioIndex: number; // 1-based index into the simulation results
  request:       string;
  pickedTool:    string;
}

interface SuggestedFix {
  name:                  string;
  originalDescription:   string;
  suggestedDescription:  string;
  reasons:               Array<'clarity' | 'scenario'>;
  scenarioContext?:      ScenarioFailureContext;
}

interface Layer2Verdict {
  readyTools:         number;
  totalTools:         number;
  scenariosFailed:    number; // scenarios where the agent picked the wrong tool
  schemaFailureCount: number; // Layer 1 protocol schemas that failed validation
  issuesCount:        number;
  shipReady:          boolean;
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

const ArgQualityResponseSchema = z.object({
  valid: z.boolean(),
  issue: z.string().optional(),
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

// Field presence, naming, and type are validated programmatically (see
// validateArgsAgainstSchema) — this prompt only judges whether the *values* an
// agent chose are actually grounded in the request, not whether they're structurally valid.
const ARG_QUALITY_RULES = `Issue rules (only when valid is false):
- Maximum 20 words, one sentence.
- Only flag the VALUE: a placeholder, an example value, or something hallucinated with no basis in the request. Do not comment on missing fields or types — those are checked separately.
- Never use these phrases: "seems off", "might be wrong", "could be improved", "doesn't look right".

GOOD: "repoName is 'example/repo' — a placeholder never mentioned in the user's request."
GOOD: "question restates the tool description instead of the specific thing the user asked about."`;

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

// ─── Layer 2: Programmatic argument-schema validation ────────────────────────
// Converts a tool's JSON Schema inputSchema into a Zod schema so that missing
// required fields, unrecognized field names, and wrong types are caught
// deterministically — no LLM judgment involved. Constructs we don't model
// precisely ($ref, anyOf/oneOf/allOf) fall back to z.unknown() rather than
// risk a false positive on a schema shape we can't faithfully represent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown();
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf) return z.unknown();

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const literals = schema.enum.map((v: unknown) => z.literal(v as any));
    return literals.length === 1 ? literals[0] : z.union(literals);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string':  return z.string();
    case 'number':  return z.number();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'null':    return z.null();
    case 'array': {
      const itemSchema = schema.items
        ? jsonSchemaToZod(Array.isArray(schema.items) ? schema.items[0] : schema.items)
        : z.unknown();
      return z.array(itemSchema);
    }
    case 'object': {
      const properties = schema.properties ?? {};
      const required: string[] = Array.isArray(schema.required) ? schema.required : [];
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const zodProp = jsonSchemaToZod(propSchema);
        shape[key] = required.includes(key) ? zodProp : zodProp.optional();
      }
      const obj = z.object(shape);
      // Extra keys an agent invents (e.g. the wrong field name) are always worth
      // flagging, even if the source schema permits additionalProperties.
      return schema.additionalProperties === true ? obj.passthrough() : obj.strict();
    }
    default:
      return z.unknown();
  }
}

function validateArgsAgainstSchema(
  inputSchema: unknown,
  args: Record<string, unknown>,
): { valid: boolean; issues: string[] } {
  const result = jsonSchemaToZod(inputSchema).safeParse(args);
  if (result.success) return { valid: true, issues: [] };

  const missing: string[] = [];
  const wrongType: Array<{ path: string; expected: string }> = [];
  const unrecognized: string[] = [];

  for (const issue of result.error.issues) {
    const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';
    if (issue.code === 'unrecognized_keys') {
      unrecognized.push(...issue.keys);
    } else if (issue.code === 'invalid_type') {
      if (issue.message.includes('received undefined')) missing.push(path);
      else wrongType.push({ path, expected: issue.expected });
    }
  }

  const messages: string[] = [];

  // A required field missing alongside an unrecognized key in the same call is
  // almost always the same mistake — the agent used the wrong field name.
  // Surface both halves together instead of reporting only "missing field" and
  // silently dropping which (wrong) name the agent actually used.
  const renamedPairCount = Math.min(missing.length, unrecognized.length);
  for (let i = 0; i < renamedPairCount; i++) {
    messages.push(
      `Used '${unrecognized[i]}' instead of the required field '${missing[i]}' — ` +
      `'${unrecognized[i]}' isn't a recognized field for this tool.`,
    );
  }
  const leftoverMissing = missing.slice(renamedPairCount);
  const leftoverUnrecognized = unrecognized.slice(renamedPairCount);

  if (leftoverUnrecognized.length > 0) {
    const keys = leftoverUnrecognized.map(k => `'${k}'`).join(', ');
    messages.push(`Unrecognized field${leftoverUnrecognized.length > 1 ? 's' : ''} ${keys} — not in schema.`);
  }
  for (const path of leftoverMissing) {
    messages.push(`Missing required field '${path}' — the schema requires it but no value was provided.`);
  }
  for (const { path, expected } of wrongType) {
    messages.push(`Field '${path}' has the wrong type — expected ${expected}.`);
  }

  return { valid: false, issues: messages };
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
): Promise<RawConfusionPair[]> {
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

// Marks each confusion pair HIGH (a scenario failure actually confirmed the mix-up)
// or LOW (flagged structurally, but no simulated failure landed on that pair).
// HIGH pairs are sorted first so confirmed risk is what a reader sees immediately.
function rankConfusionPairs(pairs: RawConfusionPair[], simulation: SimulationResult[]): ConfusionPair[] {
  const ranked = pairs.map(pair => {
    const failureIndex = simulation.findIndex(s =>
      !s.correct && (
        (s.expectedTool === pair.tool1 && s.pickedTool === pair.tool2) ||
        (s.expectedTool === pair.tool2 && s.pickedTool === pair.tool1)
      ),
    );

    if (failureIndex === -1) {
      return { ...pair, severity: 'LOW' as const };
    }
    return {
      ...pair,
      severity:              'HIGH' as const,
      confirmedByScenario:   failureIndex + 1,
      confirmedByPickedTool: simulation[failureIndex].pickedTool,
    };
  });

  return ranked.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'HIGH' ? -1 : 1;
  });
}

// ─── Layer 2: Check 3 — Compatibility Testing ────────────────────────────────

// More tools (or more flagged confusion pairs) means more ways for an agent to
// pick the wrong tool, so sample more scenarios to get reliable coverage.
function scenarioCount(toolCount: number, confusionPairCount: number): number {
  if (toolCount >= 8 || confusionPairCount >= 5) return 12;
  if (toolCount >= 4) return 8;
  return 5;
}

// Schema structure (missing/unknown fields, wrong types) is checked first and
// programmatically — deterministic, no API call. Only when the arguments are
// structurally valid do we spend an LLM call judging whether the *values*
// actually reflect the user's request rather than being placeholders or hallucinated.
async function checkArgQuality(
  tool: McpTool,
  request: string,
  args: Record<string, unknown>,
  anthropic: Anthropic,
): Promise<{ valid: boolean; issue?: string; issueType?: 'schema' | 'value' }> {
  const schemaResult = validateArgsAgainstSchema(tool.inputSchema, args);
  if (!schemaResult.valid) {
    return { valid: false, issue: schemaResult.issues[0], issueType: 'schema' };
  }

  const text = await callClaude(
    anthropic,
    'You evaluate whether tool-call argument VALUES are grounded in the user\'s request, not whether the correct tool was chosen or whether the arguments are structurally valid. Respond only with valid JSON.',
    `Tool:
Name: ${tool.name}
Description: ${tool.description ?? '(no description)'}
Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}

User request: "${request}"

Arguments an agent proposed for this call (already confirmed structurally valid):
${JSON.stringify(args, null, 2)}

Decide whether these argument VALUES are grounded in the request: no placeholder text (e.g. "string", "TODO", "example", "<value>") and no values hallucinated with no basis in what the user asked for.

${ARG_QUALITY_RULES}

Respond with JSON: {"valid":true} or {"valid":false,"issue":"<one-sentence reason>"}`,
    256,
    0,
  );
  const quality = ArgQualityResponseSchema.parse(extractJSON(text));
  if (!quality.valid) {
    return { valid: false, issue: quality.issue, issueType: 'value' };
  }
  return { valid: true };
}

async function check3Simulation(
  tools: McpTool[],
  confusedPairs: RawConfusionPair[],
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

  const results: SimulationResult[] = scenarios.map((s, i) => {
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

  // Phase C: for scenarios where the right tool was picked, separately judge whether
  // the arguments are actually usable — wrong-tool scenarios already fail regardless.
  const toolByName = new Map(tools.map(t => [t.name, t]));

  return Promise.all(results.map(async r => {
    if (!r.correct) return r;
    const tool = toolByName.get(r.expectedTool);
    if (!tool) return r;

    try {
      const quality = await checkArgQuality(tool, r.request, r.pickedArgs, anthropic);
      if (!quality.valid) {
        return { ...r, argWarning: true, argIssue: quality.issue, argIssueType: quality.issueType };
      }
    } catch { /* argument-quality check is best-effort; leave the pass as-is */ }
    return r;
  }));
}

// ─── Layer 2: Check 4 — Suggested Fixes for low-clarity tools ────────────────

async function generateFix(
  tool: McpTool,
  clarity: ClarityResult | undefined,
  partner: McpTool | undefined,
  confusionReason: string | undefined,
  scenarioFailure: ScenarioFailureContext | undefined,
  anthropic: Anthropic,
): Promise<string> {
  const context: string[] = [];

  if (clarity) {
    context.push(`Clarity score: ${clarity.score}/10\nClarity verdict: ${clarity.verdict}`);
  }

  if (scenarioFailure) {
    context.push(
      `This tool was the correct answer to a real test request, but an agent picked a different tool instead:\n` +
      `Request: "${scenarioFailure.request}"\n` +
      `Tool picked instead: ${scenarioFailure.pickedTool}`,
    );
  }

  if (partner) {
    context.push(
      `Tool it gets confused with:\n` +
      `Name: ${partner.name}\n` +
      `Description: ${partner.description ?? '(no description)'}\n` +
      `Input schema: ${JSON.stringify(partner.inputSchema, null, 2)}\n\n` +
      `Reason for confusion: ${confusionReason}`,
    );
  }

  const contrastInstruction = partner
    ? `Write a new description for "${tool.name}" ONLY. It must explicitly contrast with "${partner.name}" by name so an AI agent can reliably pick the correct one.`
    : `Write a new description that fixes the issue above so an AI agent reliably knows when to use this tool and what arguments to pass.`;

  const prompt = `Rewrite the description of the MCP tool "${tool.name}" so an AI agent picks it correctly and calls it with the right arguments.

Tool to fix:
Name: ${tool.name}
Description: ${tool.description ?? '(no description)'}
Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}

${context.join('\n\n')}

${contrastInstruction}

${SUGGESTED_FIX_RULES}

Respond with JSON: {"suggestedDescription":"<new description>"}`;

  const text = await callClaude(
    anthropic,
    'You rewrite MCP tool descriptions to make them clearer and less ambiguous for AI agents. Respond only with valid JSON — no prose, no markdown.',
    prompt,
    512,
  );
  return FixResponseSchema.parse(extractJSON(text)).suggestedDescription;
}

// Generated for low-clarity tools AND for any tool that was the expected answer in a
// failed scenario — a clear description on paper still needs to be picked correctly
// against the tool's real competition.
async function check4SuggestedFixes(
  tools: McpTool[],
  clarity: ClarityResult[],
  confusedPairs: ConfusionPair[],
  simulation: SimulationResult[],
  anthropic: Anthropic,
): Promise<SuggestedFix[]> {
  const toolByName = new Map(tools.map(t => [t.name, t]));
  const clarityByName = new Map(clarity.map(c => [c.name, c]));
  const lowClarityNames = new Set(
    clarity.filter(c => Math.round(c.score) < CLARITY_FIX_THRESHOLD).map(c => c.name),
  );

  const scenarioFailureByTool = new Map<string, ScenarioFailureContext>();
  simulation.forEach((s, i) => {
    if (!s.correct && !scenarioFailureByTool.has(s.expectedTool)) {
      scenarioFailureByTool.set(s.expectedTool, {
        scenarioIndex: i + 1,
        request:       s.request,
        pickedTool:    s.pickedTool,
      });
    }
  });

  const namesNeedingFix = new Set<string>([...lowClarityNames, ...scenarioFailureByTool.keys()]);
  if (namesNeedingFix.size === 0) return [];

  const fixes = await Promise.all(Array.from(namesNeedingFix).map(async (name): Promise<SuggestedFix | null> => {
    const tool = toolByName.get(name);
    if (!tool) return null;

    const clarityResult   = clarityByName.get(name);
    const scenarioFailure = scenarioFailureByTool.get(name);
    const pair            = confusedPairs.find(p => p.tool1 === name || p.tool2 === name);
    const partnerName     = pair ? (pair.tool1 === name ? pair.tool2 : pair.tool1) : undefined;
    const partner          = partnerName ? toolByName.get(partnerName) : undefined;

    const suggestedDescription = await generateFix(
      tool, clarityResult, partner, pair?.reason, scenarioFailure, anthropic,
    );

    const reasons: Array<'clarity' | 'scenario'> = [];
    if (lowClarityNames.has(name)) reasons.push('clarity');
    if (scenarioFailure) reasons.push('scenario');

    return {
      name,
      originalDescription: tool.description ?? '(no description)',
      suggestedDescription,
      reasons,
      ...(scenarioFailure ? { scenarioContext: scenarioFailure } : {}),
    };
  }));

  return fixes.filter((f): f is SuggestedFix => f !== null);
}

function computeVerdict(
  tools: McpTool[],
  simulation: SimulationResult[],
  suggestedFixes: SuggestedFix[],
  schemaFailureCount: number,
): Layer2Verdict {
  const totalTools = tools.length;
  const scenariosFailed = simulation.filter(s => !s.correct).length;

  const toolsWithIssues = new Set<string>([
    ...suggestedFixes.map(f => f.name),
    ...simulation.filter(s => s.argWarning).map(s => s.expectedTool),
  ]);

  const issuesCount = suggestedFixes.length + simulation.filter(s => s.argWarning).length;

  return {
    readyTools: totalTools - toolsWithIssues.size,
    totalTools,
    scenariosFailed,
    schemaFailureCount,
    issuesCount,
    shipReady: issuesCount === 0 && scenariosFailed === 0 && schemaFailureCount === 0,
  };
}

// ─── Layer 2: orchestrator ────────────────────────────────────────────────────

async function runLayer2Checks(tools: McpTool[], anthropic: Anthropic, schemaFailureCount: number): Promise<void> {
  console.log();
  divider('═');
  console.log(`${BOLD}  Layer 2 — Behavior Validation${RESET}  ${DIM}(claude-haiku-4-5)${RESET}`);
  divider('═');

  // Clarity and confusion are computed together first (before anything is printed).
  let clarityResults: ClarityResult[] | undefined;
  let clarityErr: string | undefined;
  let confusedPairsRaw: RawConfusionPair[] = [];
  let confusionErr: string | undefined;

  const runConfusion = tools.length >= 2;

  step('Analysing clarity + ambiguity');
  const [clarityOutcome, confusionOutcome] = await Promise.allSettled([
    check1Clarity(tools, anthropic),
    runConfusion ? check2Confusion(tools, anthropic) : Promise.resolve([] as RawConfusionPair[]),
  ]);

  if (clarityOutcome.status === 'fulfilled') clarityResults = clarityOutcome.value;
  else clarityErr = clarityOutcome.reason instanceof Error ? clarityOutcome.reason.message : String(clarityOutcome.reason);

  if (confusionOutcome.status === 'fulfilled') confusedPairsRaw = confusionOutcome.value;
  else confusionErr = confusionOutcome.reason instanceof Error ? confusionOutcome.reason.message : String(confusionOutcome.reason);
  stepDoneCustom('Analysing clarity + ambiguity… ', `${GREEN}done${RESET}`);

  // Compatibility testing must finish before we can rank confusion pairs or generate
  // fixes for scenario failures — both depend on knowing which scenarios failed.
  let sims: SimulationResult[] = [];
  let simErr: string | undefined;
  const simCount = scenarioCount(tools.length, confusedPairsRaw.length);
  step(`Running compatibility tests (${simCount} scenarios)`);
  try {
    sims = await check3Simulation(tools, confusedPairsRaw, anthropic);
  } catch (err) {
    simErr = err instanceof Error ? err.message : String(err);
  }
  stepDoneCustom('Running compatibility tests… ', `${GREEN}done${RESET}`);

  const confusedPairs = rankConfusionPairs(confusedPairsRaw, sims);

  let fixes: SuggestedFix[] = [];
  if (clarityResults) {
    try {
      fixes = await check4SuggestedFixes(tools, clarityResults, confusedPairs, sims, anthropic);
    } catch { /* suggested fixes are best-effort; ignore failures */ }
  }
  const fixByName = new Map(fixes.map(f => [f.name, f]));

  const verdict = computeVerdict(tools, sims, fixes, schemaFailureCount);

  // ── Overall verdict ───────────────────────────────────────────────────────
  // Schema failures and scenario failures are reported separately — never claim
  // "failed protocol schemas" when Layer 1 passed every tool, and vice versa.
  console.log();
  if (verdict.shipReady) {
    console.log(`  ${GREEN}${BOLD}✓ Server ready to ship${RESET}\n`);
  } else {
    const issueWord = verdict.issuesCount === 1 ? 'issue' : 'issues';

    const criticalParts: string[] = [];
    if (verdict.schemaFailureCount > 0) {
      criticalParts.push(`${verdict.schemaFailureCount} failed protocol schema${verdict.schemaFailureCount === 1 ? '' : 's'}`);
    }
    if (verdict.scenariosFailed > 0) {
      criticalParts.push(`${verdict.scenariosFailed} scenario${verdict.scenariosFailed === 1 ? '' : 's'} where the agent picked the wrong tool`);
    }

    console.log(`  ${YELLOW}${BOLD}${verdict.issuesCount} ${issueWord} found before shipping${RESET}`);
    console.log(
      `  ${DIM}${verdict.readyTools}/${verdict.totalTools} tools ready to ship` +
      (criticalParts.length > 0 ? ` · ${criticalParts.join(' and ')}` : '') +
      ` · ${verdict.issuesCount} ${issueWord} need fixing${RESET}\n`,
    );
  }

  // ── Check 1: Clarity Analysis ─────────────────────────────────────────────
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
        if (fix.scenarioContext) {
          console.log(
            `       ${DIM}Triggered by Scenario ${fix.scenarioContext.scenarioIndex} — ` +
            `agent picked ${fix.scenarioContext.pickedTool} instead of this tool.${RESET}`,
          );
        }
      }
      console.log();
    }
  }

  // ── Check 2: Ambiguity Analysis ───────────────────────────────────────────
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
      const isHigh = p.severity === 'HIGH';
      const color  = isHigh ? RED : YELLOW;
      const badge  = isHigh
        ? `  ${RED}${BOLD}[HIGH — confirmed by simulation]${RESET}`
        : `  ${DIM}[LOW — not confirmed]${RESET}`;

      console.log(`  ${color}⚠ ${BOLD}${p.tool1}${RESET}${color} ↔ ${BOLD}${p.tool2}${RESET}${badge}`);
      console.log(`    ${p.reason}`);
      if (isHigh && p.confirmedByScenario) {
        console.log(`    ${RED}Confirmed by Scenario ${p.confirmedByScenario} — agent picked ${p.confirmedByPickedTool} instead.${RESET}`);
      }
      console.log();
    }
  }

  // ── Check 3: Compatibility Testing ────────────────────────────────────────
  divider();
  console.log(`\n  ${BOLD}CHECK 3 · COMPATIBILITY TESTING${RESET}\n`);
  divider();
  console.log();

  if (simErr) {
    console.log(`  ${RED}Check 3 failed: ${simErr}${RESET}\n`);
  } else {
    for (let i = 0; i < sims.length; i++) {
      const s = sims[i];
      const badge = !s.correct
        ? `${RED}✗${RESET}`
        : s.argWarning
          ? `${YELLOW}⚠ PASS (${s.argIssueType === 'schema' ? 'schema violation' : 'wrong args'})${RESET}`
          : `${GREEN}✓${RESET}`;
      const argsStr = Object.keys(s.pickedArgs).length > 0
        ? JSON.stringify(s.pickedArgs)
        : '{}';

      console.log(`  ${DIM}Scenario ${i + 1}:${RESET} "${truncate(s.request, 78)}"`);
      console.log(`    Expected: ${BOLD}${s.expectedTool}${RESET}  →  Picked: ${BOLD}${s.pickedTool}${RESET}  ${badge}`);
      console.log(`    Args:     ${DIM}${truncate(argsStr, 80)}${RESET}`);
      if (s.argWarning && s.argIssue) {
        const label = s.argIssueType === 'schema' ? 'Schema violation (programmatic)' : 'Value quality warning (heuristic)';
        console.log(`    ${YELLOW}${label}: ${s.argIssue}${RESET}`);
      }
      console.log();
    }

    const correct = sims.filter(s => s.correct).length;
    const total   = sims.length;
    const scoreColor = correct === total ? GREEN : correct >= Math.ceil(total / 2) ? YELLOW : RED;
    console.log(`  ${BOLD}Score: ${scoreColor}${correct}/${total} passed${RESET}\n`);
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

  posthog.capture({ distinctId: 'anonymous', event: 'cli_check_started', properties: { server_url: url, run_ai: runAi } });

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

    posthog.capture({
      distinctId: 'anonymous',
      event: 'cli_layer1_completed',
      properties: {
        server_url: url,
        tool_count: results.length,
        passed_count: passed,
        failed_count: failed,
        server_name: mcpClient.getServerVersion()?.name ?? null,
      },
    });

    if (failed > 0) process.exitCode = 1;

    // ── Layer 2 (optional) ────────────────────────────────────────────────────
    if (runAi && anthropic) {
      await runLayer2Checks(tools as McpTool[], anthropic, failed);
      posthog.capture({ distinctId: 'anonymous', event: 'cli_layer2_completed', properties: { server_url: url, tool_count: tools.length } });
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Error: ${msg}${RESET}\n`);
    posthog.captureException(sanitizeErrorForCapture(err, [process.env.ANTHROPIC_API_KEY]), 'anonymous', { server_url: url });
    posthog.capture({ distinctId: 'anonymous', event: 'cli_check_error', properties: { server_url: url, error_message: msg } });
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

program.parseAsync(process.argv)
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => posthog.shutdown());
