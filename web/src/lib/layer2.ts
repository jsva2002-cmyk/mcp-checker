import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  ToolInfo, Layer2Report, Layer2Verdict, ClarityResult, ConfusionPair,
  SimulationResult, SuggestedFix, ScenarioFailureContext,
} from './types';

const CLARITY_FIX_THRESHOLD = 7;

// Shape returned by Check 2 before simulation results are known to rank severity.
type RawConfusionPair = Pick<ConfusionPair, 'tool1' | 'tool2' | 'reason'>;

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

const ArgQualityResponseSchema = z.object({
  valid: z.boolean(),
  issue: z.string().optional(),
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

// ─── Programmatic argument-schema validation ─────────────────────────────────
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

  const issues = result.error.issues.map(issue => {
    const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';

    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map(k => `'${k}'`).join(', ');
      return `Unexpected field${issue.keys.length > 1 ? 's' : ''} ${keys} — not defined in the tool's schema.`;
    }
    if (issue.code === 'invalid_type') {
      if (issue.message.includes('received undefined')) {
        return `Missing required field '${path}' — the schema requires it but no value was provided.`;
      }
      return `Field '${path}' has the wrong type — expected ${issue.expected}.`;
    }
    return `'${path}': ${issue.message}`;
  });

  return { valid: false, issues };
}

// ─── Check 1: Clarity Analysis ───────────────────────────────────────────────

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

// ─── Check 2: Ambiguity Analysis ─────────────────────────────────────────────

async function check2Confusion(tools: ToolInfo[], anthropic: Anthropic): Promise<RawConfusionPair[]> {
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

// ─── Check 3: Compatibility Testing ──────────────────────────────────────────

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
  tool: ToolInfo,
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
  tools: ToolInfo[],
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
    `Given these MCP tools, generate exactly ${count} diverse, realistic user request scenarios. Each scenario must have a clear single correct tool.
${confusionBlock}
Tools:
${toolsToPromptText(tools)}

Respond with a JSON array of exactly ${count} items:
[{"request":"<user request>","expectedTool":"<tool_name>"}]`,
    Math.max(1024, count * 200),
  );
  const scenarios = ScenariosResponseSchema.parse(extractJSON(genText));

  // Phase B: for each scenario, ask Claude to pick a tool independently.
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

// ─── Check 4: Recommended fixes ──────────────────────────────────────────────
// Generated for low-clarity tools AND for any tool that was the expected answer
// in a failed scenario — a clear description on paper still needs to be picked
// correctly against the tool's real competition.

async function generateFix(
  tool: ToolInfo,
  clarity: ClarityResult | undefined,
  partner: ToolInfo | undefined,
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

async function check4SuggestedFixes(
  tools: ToolInfo[],
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

    const clarityResult    = clarityByName.get(name);
    const scenarioFailure  = scenarioFailureByTool.get(name);
    const pair             = confusedPairs.find(p => p.tool1 === name || p.tool2 === name);
    const partnerName      = pair ? (pair.tool1 === name ? pair.tool2 : pair.tool1) : undefined;
    const partner          = partnerName ? toolByName.get(partnerName) : undefined;

    const suggestedDescription = await generateFix(
      tool, clarityResult, partner, pair?.reason, scenarioFailure, anthropic,
    );

    const reasons: Array<'clarity' | 'scenario'> = [];
    if (lowClarityNames.has(name)) reasons.push('clarity');
    if (scenarioFailure) reasons.push('scenario');

    return {
      name,
      originalDescription:  tool.description ?? '(no description)',
      suggestedDescription,
      reasons,
      ...(scenarioFailure ? { scenarioContext: scenarioFailure } : {}),
    };
  }));

  return fixes.filter((f): f is SuggestedFix => f !== null);
}

// ─── Overall verdict ──────────────────────────────────────────────────────────

function computeVerdict(
  tools: ToolInfo[],
  simulation: SimulationResult[],
  suggestedFixes: SuggestedFix[],
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
    issuesCount,
    shipReady: issuesCount === 0 && scenariosFailed === 0,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runLayer2(tools: ToolInfo[], apiKey: string): Promise<Layer2Report> {
  const anthropic = new Anthropic({ apiKey });

  // Clarity + Confusion run in parallel (each is one Claude call).
  const [clarity, confusedPairsRaw] = await Promise.all([
    check1Clarity(tools, anthropic),
    check2Confusion(tools, anthropic),
  ]);

  // Simulation must finish before we can rank confusion pairs or generate fixes for
  // scenario failures — both depend on knowing which scenarios actually failed.
  const simulation = await check3Simulation(tools, confusedPairsRaw, anthropic);

  const confusedPairs = rankConfusionPairs(confusedPairsRaw, simulation);
  const suggestedFixes = await check4SuggestedFixes(tools, clarity, confusedPairs, simulation, anthropic);
  const verdict = computeVerdict(tools, simulation, suggestedFixes);

  return {
    clarity,
    confusedPairs,
    simulation,
    simulationScore: simulation.filter(s => s.correct).length,
    suggestedFixes,
    verdict,
  };
}
