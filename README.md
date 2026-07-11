# MCP Checker

Validate your MCP server before you ship.

## The problem

MCP servers expose tools to agents through nothing but a name, a description, and a JSON Schema. There's no compiler, no type system, no test suite that catches "this description is ambiguous enough that an agent will call the wrong tool 30% of the time." The server passes every schema validator you throw at it — and still fails in production, silently, because an agent picked `list_files` when it meant `search_files`.

Existing tools stop at structural validation: does `inputSchema` conform to JSON Schema, are required fields present, does the server respond to `tools/list`. That tells you the server is *well-formed*. It tells you nothing about whether the server is *usable* — whether an agent reading these tool descriptions in a real conversation can reliably tell them apart and call them correctly.

## What makes it different

- **Zero setup.** No config files, no hand-written test cases. Paste a URL, get a full validation report.
- **Compatibility testing, not just linting.** Realistic request scenarios are generated from your actual tool set, an agent picks a tool for each one independently, and the pick is checked against the correct answer — including scenarios specifically engineered to probe any tool pairs flagged as ambiguous.
- **Two layers, one run.** Protocol validation and behavior validation happen in the same pass, so you see both "is this schema valid" and "will an agent actually call it correctly" side by side.

## Quick start

Requires Node 18+.

```bash
git clone <repo-url>
cd mcp-checker
npm install

# Layer 1 only — protocol validation, no API key needed
npm run check https://mcp.deepwiki.com/mcp

# Layer 1 + Layer 2 — adds behavior validation (needs ANTHROPIC_API_KEY)
npm run check https://mcp.deepwiki.com/mcp -- --ai
```

Set `ANTHROPIC_API_KEY` in a `.env` file at the project root, or export it in your shell, to enable `--ai`.

```bash
npm run build   # compile to dist/
```

## Web app

The web app is a hosted, zero-install version of the same checks: paste an MCP server URL, get a report in the browser. No account, no CLI, no API key of your own — just point it at a public MCP server.

**https://web-mu-two-87.vercel.app**

Layer 1 runs for free with no limits beyond IP-based rate limiting (10 checks/hour). Layer 2 runs on the same request when you toggle it on.

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
  Layer 2 — Behavior Validation  (claude-haiku-4-5)
══════════════════════════════════════════════════════════

  2 issues found before shipping
  1/3 tools ready to ship · 2 scenarios failed · 2 issues need fixing

  CHECK 1 · CLARITY ANALYSIS

  [1/3] read_wiki_structure
       Clarity: 7/10  — Missing description of what the returned list
       contains or how many topics are included by default.

  [2/3] read_wiki_contents
       Clarity: 5/10  — Fails to specify which documentation page is
       returned or whether an agent must pass a topic name to retrieve
       specific content.
       Recommended fix: Retrieve the complete documentation content for a
       GitHub repository. Use this to read full wiki contents after
       identifying topics with read_wiki_structure — this returns actual
       content, not a list of topics.
       Triggered by Scenario 2 — agent picked read_wiki_structure instead
       of this tool.

  [3/3] ask_question
       Clarity: 8/10  — Clear dual-format input and max repository count
       are well-defined; lacks detail on response format or length
       constraints only.

  CHECK 2 · AMBIGUITY ANALYSIS

  ⚠ read_wiki_structure ↔ read_wiki_contents  [HIGH — confirmed by simulation]
    Both require only repoName and both access repository documentation —
    an agent has no signal to distinguish topic-listing from content-retrieval.
    Confirmed by Scenario 2 — agent picked read_wiki_structure instead.

  CHECK 3 · COMPATIBILITY TESTING

  Scenario 1: "I need to see all the available documentation pages for the
  tensorflow/tensorflow repo"
    Expected: read_wiki_structure  →  Picked: read_wiki_structure  ✓
    Args:     {"repoName":"tensorflow/tensorflow"}

  Scenario 2: "Show me the full documentation content for kubernetes/kubernetes.
  I want to read the actual pages"
    Expected: read_wiki_contents  →  Picked: read_wiki_structure  ✗
    Args:     {"repoName":"kubernetes/kubernetes"}

  Scenario 3: "Can you help me understand the differences between React and Vue?"
    Expected: ask_question  →  Picked: ask_question  ✓
    Args:     {"repoName":["facebook/react","vuejs/vue"],"question":"What are
    the key differences?"}

  Scenario 4: "I'm looking at the docker/cli repository and I want to get an
  overview of what's documented there"
    Expected: read_wiki_structure  →  Picked: read_wiki_structure  ⚠ PASS (wrong args)
    Args:     {"repoName":"example/repo"}
    repoName is 'example/repo' — a placeholder never mentioned in the user's
    request for 'docker/cli'.

  Scenario 5: "Pull up the documentation for golang/go. I need to read through
  their wiki"
    Expected: read_wiki_contents  →  Picked: read_wiki_structure  ✗
    Args:     {"repoName":"golang/go"}

  Score: 3/5 passed
══════════════════════════════════════════════════════════
```

Scenarios 2 and 5 are the failures the ambiguity check predicted: the agent had a specific page in mind but picked the topic-listing tool anyway, because nothing in either description said which tool to use once you already know the page you want — that's what promotes the confusion pair to HIGH. Scenario 4 is a different failure mode: the right tool was picked, but the agent filled `repoName` with a placeholder instead of the repository actually named in the request — a passing tool selection with unusable arguments underneath it.

## How it works

### Layer 1 — Protocol validation

Connects to the server over MCP's Streamable HTTP transport, calls `tools/list`, and runs every tool's `inputSchema` through a full JSON Schema validator (built on Zod) that checks it's a well-formed `type: "object"` schema per the MCP spec — correct `properties`, `required`, nested `$ref`/`$defs`, composition keywords (`anyOf`/`oneOf`/`allOf`), the works. This is pure structural validation: no network calls beyond the MCP connection itself, no API key required, runs in milliseconds per tool.

### Layer 2 — Behavior validation (`--ai`)

Layer 1 tells you the schema parses. Layer 2 tells you whether an agent can actually use it correctly:

1. **Clarity analysis** — scores each tool's description 1–10 and states the specific problem (missing format, ambiguous scope, unclear return value) rather than a vague "could be clearer."
2. **Ambiguity analysis** — compares every pair of tools and flags pairs whose descriptions overlap enough that an agent has no reliable signal to pick between them, naming the exact overlapping words or parameters. Each flagged pair is then ranked **HIGH** if a compatibility-test scenario actually confirmed the mix-up, or **LOW** if it's only a structural resemblance nothing in simulation triggered — HIGH pairs sort first and cite the exact scenario and wrong pick that confirmed them.
3. **Compatibility testing** — generates realistic user requests (more scenarios for servers with more tools or more flagged ambiguous pairs) with a known-correct tool, then has an agent pick a tool for each request *independently*, blind to which tool was "expected." Scenarios are deliberately seeded to probe any pairs flagged by the ambiguity check. Tool-picking runs at a fixed, deterministic temperature so results are stable across runs. When the right tool *is* picked, a follow-up check separately judges whether the arguments are actually usable — no placeholders, hallucinated values, missing required fields, or nonsensical types — surfaced as a distinct `⚠ PASS (wrong args)` state rather than folded into a hard pass/fail.
4. **Recommended fixes** — generated for any tool scoring below 7/10, *and* for any tool that was the correct answer in a failed scenario but wasn't picked, even if its clarity score was fine on paper. Fixes explicitly contrast against an ambiguity partner by name if one exists, and cite the scenario that triggered them when relevant.
5. **Overall verdict** — a one-line summary computed from the above (`N/M tools ready to ship · X scenarios failed · Y issues need fixing`, or `Server ready to ship` when nothing needs fixing) leads the Layer 2 report before any individual check is shown.

All Claude responses are parsed and validated through Zod schemas before being trusted — a malformed or off-spec response fails loudly instead of corrupting the report.

## Tech stack

**CLI** (`src/`)
- TypeScript, run directly via [`tsx`](https://github.com/privatenumber/tsx) (not `ts-node` — the MCP SDK's extensionless export map needs esbuild's resolver)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) for the MCP client / Streamable HTTP transport
- [`commander`](https://github.com/tj/commander.js) for the CLI surface
- [`zod`](https://github.com/colinhacks/zod) v4 for JSON Schema validation and for validating structured responses
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
- Layer 2 prompts are deliberately strict about output format (see the `*_RULES` constants in `checker.ts`) to keep verdicts specific instead of hedgy — if you touch those, sanity-check a few real runs, not just the schema.
- `npm run build` compiles the CLI with `tsc`; there's no build step required for local development (`npm run check` runs directly through `tsx`).

Open a PR against `main`.
