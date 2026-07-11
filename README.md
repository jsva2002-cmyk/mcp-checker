# MCP Checker

Point it at an MCP server URL. Find out if an AI agent will actually pick the right tool — before your users do.

## The problem

MCP servers expose tools to AI agents through nothing but a name, a description, and a JSON Schema. There's no compiler, no type system, no test suite that catches "this description is ambiguous enough that Claude will call the wrong tool 30% of the time." The server works perfectly in every schema validator you throw at it — and still fails in production, silently, because an agent picked `list_files` when it meant `search_files`.

Existing tools stop at structural validation: does `inputSchema` conform to JSON Schema, are required fields present, does the server respond to `tools/list`. That tells you the server is *well-formed*. It tells you nothing about whether the server is *usable* — whether an LLM reading these tool descriptions in a real conversation can reliably tell them apart.

## What makes it different

- **Automatic scenario generation.** You don't write eval cases. MCP Checker generates realistic user requests from your actual tool set, then has an agent pick a tool for each one independently and checks whether it picked correctly — including scenarios specifically engineered to probe any tool pairs flagged as confusable.
- **Zero setup.** No config file, no fixtures, no API mocking. One command, one URL, a full report.
- **Two layers, one run.** Structural validation and AI-reasoning validation happen in the same pass, so you see both "is this schema valid" and "will an agent actually use it right" side by side.

## Quick start

Requires Node 18+.

```bash
git clone <repo-url>
cd mcp-checker
npm install

# Layer 1 only — schema validation, no API key needed
npm run check https://mcp.deepwiki.com/mcp

# Layer 1 + Layer 2 — adds AI reasoning checks (needs ANTHROPIC_API_KEY)
npm run check https://mcp.deepwiki.com/mcp -- --ai
```

Set `ANTHROPIC_API_KEY` in a `.env` file at the project root, or export it in your shell, to enable `--ai`.

```bash
npm run build   # compile to dist/
```

## Web app

The web app is a hosted, zero-install version of the same checks: paste an MCP server URL, get a report in the browser. No account, no CLI, no API key of your own — just point it at a public MCP server.

**https://web-mu-two-87.vercel.app**

Layer 1 runs for free with no limits beyond IP-based rate limiting (10 checks/hour). Layer 2 (AI checks) runs on the same request when you toggle it on.

## Example output

Running against a real MCP server with 3 tools:

```
══════════════════════════════════════════════════════════
  MCP Server Checker
  Target: https://mcp.deepwiki.com/mcp
══════════════════════════════════════════════════════════

  Connecting… connected
  Server: deepwiki v2.14.3
  Fetching tools… 3 found

  ──────────────────────────────────────────────────────────

  [1/3] read_wiki_structure
       Desc:   Get a list of documentation topics for a GitHub repository
       Schema: ✓ PASSED

  [2/3] read_wiki_contents
       Desc:   View documentation about a GitHub repository
       Schema: ✓ PASSED

  [3/3] ask_question
       Desc:   Ask any question about a GitHub repository
       Schema: ✓ PASSED

  ──────────────────────────────────────────────────────────

  Layer 1 Summary: 3 tools — 3 passed, 0 failed
══════════════════════════════════════════════════════════

══════════════════════════════════════════════════════════
  Layer 2 — AI Reasoning Checks  (claude-haiku-4-5)
══════════════════════════════════════════════════════════

  CHECK 1 · DESCRIPTION CLARITY

  [1/3] read_wiki_structure
       Clarity: 8/10  — Clear on what it lists, but doesn't say the topics
       returned are usable as arguments to read_wiki_contents.

  [2/3] read_wiki_contents
       Clarity: 5/10  — Doesn't specify whether page identifiers come from
       read_wiki_structure or the raw repo path — an agent may guess wrong.
       Suggested fix: Retrieves the full markdown content of a specific wiki
       page. Use this after read_wiki_structure to read a page's content —
       not to list available topics.

  [3/3] ask_question
       Clarity: 9/10  — Clearly scoped to free-form Q&A, distinct from the
       two structured retrieval tools.

  CHECK 2 · TOOL CONFUSION DETECTION

  ⚠ read_wiki_structure ↔ read_wiki_contents
    Both take only repoName and both mention "documentation" — an agent has
    no signal to distinguish topic-listing from content-retrieval.

  CHECK 3 · SCENARIO SIMULATION

  Scenario 1: "What topics does the facebook/react wiki cover?"
    Expected: read_wiki_structure  →  Picked: read_wiki_structure  ✓
    Args:     {"repoName":"facebook/react"}

  Scenario 2: "Show me the contents of the 'Getting Started' page for vercel/next.js"
    Expected: read_wiki_contents  →  Picked: read_wiki_structure  ✗
    Args:     {"repoName":"vercel/next.js"}

  Scenario 3: "How does React's reconciliation algorithm work?"
    Expected: ask_question  →  Picked: ask_question  ✓
    Args:     {"repoName":"facebook/react","question":"How does reconciliation work?"}

  Scenario 4: "List the documentation sections available for expressjs/express"
    Expected: read_wiki_structure  →  Picked: read_wiki_structure  ✓
    Args:     {"repoName":"expressjs/express"}

  Scenario 5: "Give me the full text of the API reference page for tailwindlabs/tailwindcss"
    Expected: read_wiki_contents  →  Picked: read_wiki_contents  ✓
    Args:     {"repoName":"tailwindlabs/tailwindcss","page":"API reference"}

  Score: 4/5 passed
══════════════════════════════════════════════════════════
```

Scenario 2 is the failure the confusion check predicted: the agent had a specific page in mind but picked the topic-listing tool anyway, because nothing in either description said which tool to use once you already know the page you want.

## How it works

### Layer 1 — Schema validation

Connects to the server over MCP's Streamable HTTP transport, calls `tools/list`, and runs every tool's `inputSchema` through a full JSON Schema validator (built on Zod) that checks it's a well-formed `type: "object"` schema per the MCP spec — correct `properties`, `required`, nested `$ref`/`$defs`, composition keywords (`anyOf`/`oneOf`/`allOf`), the works. This is pure structural validation: no network calls beyond the MCP connection itself, no API key required, runs in milliseconds per tool.

### Layer 2 — AI reasoning checks (`--ai`)

Layer 1 tells you the schema parses. Layer 2 tells you whether an agent can actually use it correctly, via four checks run against Claude:

1. **Clarity** — scores each tool's description 1–10 and states the specific problem (missing format, ambiguous scope, unclear return value) rather than a vague "could be clearer."
2. **Confusion detection** — compares every pair of tools and flags pairs whose descriptions overlap enough that an agent has no reliable signal to pick between them, naming the exact overlapping words or parameters.
3. **Scenario simulation** — generates realistic user requests (more scenarios for servers with more tools or more flagged confusion pairs) with a known-correct tool, then has Claude pick a tool for each request *independently*, blind to which tool was "expected." Scenarios are deliberately seeded to probe any pairs Check 2 flagged. Tool-picking runs at temperature 0 so results are stable across runs.
4. **Suggested fixes** — for any tool scoring below 7/10, generates a drop-in replacement description, explicitly contrasting it against its confusion partner by name if one exists.

All four Claude responses are parsed and validated through Zod schemas before being trusted — a malformed or off-spec response fails loudly instead of corrupting the report.

## Tech stack

**CLI** (`src/`)
- TypeScript, run directly via [`tsx`](https://github.com/privatenumber/tsx) (not `ts-node` — the MCP SDK's extensionless export map needs esbuild's resolver)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) for the MCP client / Streamable HTTP transport
- [`commander`](https://github.com/tj/commander.js) for the CLI surface
- [`zod`](https://github.com/colinhacks/zod) v4 for JSON Schema validation and for validating Claude's structured responses
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) for Layer 2, model `claude-haiku-4-5`

**Web app** (`web/`)
- Next.js 15 (App Router) + React 19
- Tailwind CSS
- Same Layer 1/Layer 2 logic as the CLI, exposed via `/api/check` and `/api/check-ai` route handlers
- [Upstash Redis](https://upstash.com/) for IP-based rate limiting
- Deployed on Vercel

## Contributing

Issues and PRs welcome. A few things worth knowing before you dig in:

- The root project (`src/checker.ts`) is the CLI; `web/` is a separate Next.js app that reimplements the same Layer 1/Layer 2 logic (`web/src/lib/layer1.ts`, `web/src/lib/layer2.ts`) behind API routes. If you change checker behavior, update both.
- Layer 2 prompts are deliberately strict about output format (see the `*_RULES` constants in `checker.ts`) to keep Claude's verdicts specific instead of hedgy — if you touch those, sanity-check a few real runs, not just the schema.
- `npm run build` compiles the CLI with `tsc`; there's no build step required for local development (`npm run check` runs directly through `tsx`).

Open a PR against `main`.
