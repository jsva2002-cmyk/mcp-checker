#!/usr/bin/env ts-node

import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { z } from 'zod';

// ─── JSON Schema validator ────────────────────────────────────────────────────

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

interface ToolResult {
  name:         string;
  title?:       string;
  description?: string;
  passed:       boolean;
  errors?:      string[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

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

function divider(char = '─', width = 62) {
  console.log(char.repeat(width));
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function checkServer(url: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client    = new Client(
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
    await client.connect(transport);
    console.log(`\r  Connecting… ${GREEN}connected${RESET}       `);

    const serverInfo = client.getServerVersion();
    if (serverInfo) {
      console.log(`  Server: ${BOLD}${serverInfo.name}${RESET} v${serverInfo.version}`);
    }

    const caps = client.getServerCapabilities();
    if (!caps?.tools) {
      console.log(`\n  ${YELLOW}⚠  Server does not advertise tool support.${RESET}\n`);
      return;
    }

    // ── List tools (paginated) ────────────────────────────────────────────────
    process.stdout.write('  Fetching tools…');

    const tools: Awaited<ReturnType<typeof client.listTools>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    console.log(`\r  Fetching tools… ${tools.length} found          `);
    console.log();
    divider();
    console.log();

    // ── Validate & print each tool ────────────────────────────────────────────
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

    // ── Summary ───────────────────────────────────────────────────────────────
    divider();
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    console.log(
      `\n  ${BOLD}Summary:${RESET} ${results.length} tool${results.length !== 1 ? 's' : ''} — ` +
      `${GREEN}${passed} passed${RESET}, ` +
      `${failed > 0 ? RED : GREEN}${failed} failed${RESET}\n`
    );
    divider('═');
    console.log();

    if (failed > 0) process.exitCode = 1;

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
  .description('Inspect an MCP server: list tools and validate their JSON schemas')
  .version('1.0.0')
  .argument('<url>', 'MCP server endpoint (Streamable HTTP transport)')
  .action(async (url: string) => {
    await checkServer(url);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
