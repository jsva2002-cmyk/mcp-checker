import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { z } from 'zod';
import type { Layer1Report, ToolSchemaResult, ToolInfo } from './types';

// ─── JSON Schema validator (mirrors src/checker.ts Layer 1 exactly) ───────────

const JSON_SCHEMA_TYPES = [
  'string', 'number', 'integer', 'boolean', 'null', 'object', 'array',
] as const;

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
    minLength:            z.number().int().nonnegative().optional(),
    maxLength:            z.number().int().nonnegative().optional(),
    pattern:              z.string().optional(),
    minimum:              z.number().optional(),
    maximum:              z.number().optional(),
    exclusiveMinimum:     z.union([z.number(), z.boolean()]).optional(),
    exclusiveMaximum:     z.union([z.number(), z.boolean()]).optional(),
    multipleOf:           z.number().positive().optional(),
    items:                z.union([JsonSchemaPropertySchema, z.array(JsonSchemaPropertySchema)]).optional(),
    minItems:             z.number().int().nonnegative().optional(),
    maxItems:             z.number().int().nonnegative().optional(),
    uniqueItems:          z.boolean().optional(),
    properties:           z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required:             z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaPropertySchema]).optional(),
    patternProperties:    z.record(z.string(), JsonSchemaPropertySchema).optional(),
    anyOf:       z.array(JsonSchemaPropertySchema).optional(),
    oneOf:       z.array(JsonSchemaPropertySchema).optional(),
    allOf:       z.array(JsonSchemaPropertySchema).optional(),
    not:         JsonSchemaPropertySchema.optional(),
    $ref:        z.string().optional(),
    $defs:       z.record(z.string(), JsonSchemaPropertySchema).optional(),
    definitions: z.record(z.string(), JsonSchemaPropertySchema).optional(),
  }).passthrough()
);

const ToolInputSchemaValidator = z.object({
  type:       z.literal('object'),
  properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
  required:   z.array(z.string()).optional(),
}).passthrough();

function validateSchema(schema: unknown): { passed: boolean; errors?: string[] } {
  const result = ToolInputSchemaValidator.safeParse(schema);
  if (result.success) return { passed: true };
  const errors = result.error.issues.map(issue => {
    const p = issue.path.length ? issue.path.map(String).join('.') : 'root';
    return `at .${p}: ${issue.message}`;
  });
  return { passed: false, errors };
}

// ─── MCP connection ───────────────────────────────────────────────────────────

export async function runLayer1(url: string, authHeader?: string): Promise<Layer1Report> {
  const transport = new StreamableHTTPClientTransport(new URL(url), authHeader
    ? { requestInit: { headers: { Authorization: authHeader } } }
    : undefined);
  const mcpClient = new Client(
    { name: 'mcp-checker-web', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await mcpClient.connect(transport);

    const serverInfo = mcpClient.getServerVersion();
    const caps = mcpClient.getServerCapabilities();

    if (!caps?.tools) {
      return {
        serverName:         serverInfo?.name,
        serverVersion:      serverInfo?.version,
        toolCount:          0,
        results:            [],
        tools:              [],
        noToolsCapability:  true,
      };
    }

    const rawTools: Awaited<ReturnType<typeof mcpClient.listTools>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await mcpClient.listTools(cursor ? { cursor } : undefined);
      rawTools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const results: ToolSchemaResult[] = rawTools.map(tool => {
      const v = validateSchema(tool.inputSchema);
      return {
        name:          tool.name,
        title:         tool.annotations?.title,
        description:   tool.description,
        schemaPassed:  v.passed,
        schemaErrors:  v.errors,
      };
    });

    const tools: ToolInfo[] = rawTools.map(tool => ({
      name:        tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      title:       tool.annotations?.title,
    }));

    return {
      serverName:    serverInfo?.name,
      serverVersion: serverInfo?.version,
      toolCount:     rawTools.length,
      results,
      tools,
    };
  } finally {
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}
