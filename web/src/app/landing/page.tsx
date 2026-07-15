'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const GITHUB_REPO_URL = 'https://github.com/jsva2002-cmyk/mcp-checker';

// ─── Logo ───────────────────────────────────────────────────────────────────

function LogoMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-suggestion flex-shrink-0">
      <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Navbar ─────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <header className="border-b border-line">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark />
          <span className="font-mono font-semibold text-fg text-sm">Problex</span>
        </Link>
        <div className="flex items-center gap-4">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted hover:text-fg transition-colors"
          >
            GitHub
          </a>
          <Link
            href="/check"
            className="px-3 py-1.5 bg-suggestion hover:brightness-110 active:brightness-90
                       text-canvas font-semibold text-xs rounded transition-[filter] whitespace-nowrap"
          >
            Validate Server →
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="max-w-3xl mx-auto px-6 pt-20 pb-16 text-center">
      <h1 className="text-3xl sm:text-4xl md:text-[2.75rem] font-bold text-fg tracking-tight leading-tight">
        Ship MCP servers agents can actually use.
      </h1>
      <p className="mt-4 text-sm sm:text-base text-muted max-w-xl mx-auto leading-relaxed">
        Validate any public MCP server for protocol compliance, tool clarity, compatibility
        risks, and production readiness. Generate a complete engineering report in seconds.
      </p>
      <div className="mt-7 flex items-center justify-center gap-3 flex-wrap">
        <Link
          href="/check"
          className="px-5 py-2.5 bg-suggestion hover:brightness-110 active:brightness-90
                     text-canvas font-semibold text-sm rounded transition-[filter]"
        >
          Validate Server →
        </Link>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="px-5 py-2.5 border border-line hover:border-suggestion/50 text-fg
                     font-semibold text-sm rounded transition-colors"
        >
          View on GitHub →
        </a>
      </div>
      <p className="mt-5 text-[11px] text-muted/70">
        Free during Beta · No account required · 10 validations per hour · Works with any public MCP server
      </p>
    </section>
  );
}

// ─── Terminal demo ──────────────────────────────────────────────────────────

type LineTone = 'prompt' | 'muted' | 'fg' | 'success' | 'warning' | 'heading' | 'divider';

interface DemoLine {
  text: string;
  tone: LineTone;
  delay: number; // ms to wait after this line before revealing the next one
}

const DEMO_LINES: DemoLine[] = [
  { text: 'problex check https://mcp.deepwiki.com/mcp', tone: 'prompt', delay: 500 },
  { text: '', tone: 'fg', delay: 150 },
  { text: 'Connecting to mcp.deepwiki.com...  ✓', tone: 'fg', delay: 400 },
  { text: 'MCP handshake complete', tone: 'muted', delay: 250 },
  { text: 'Discovered 3 tools', tone: 'fg', delay: 350 },
  { text: '', tone: 'fg', delay: 150 },
  { text: 'Layer 1 · Protocol Validation', tone: 'heading', delay: 300 },
  { text: '✓ read_wiki_structure    schema valid', tone: 'fg', delay: 220 },
  { text: '✓ read_wiki_contents     schema valid', tone: 'fg', delay: 220 },
  { text: '✓ ask_question           schema valid', tone: 'fg', delay: 220 },
  { text: '3/3 passed', tone: 'success', delay: 400 },
  { text: '', tone: 'fg', delay: 200 },
  { text: 'Layer 2 · Behavior Validation', tone: 'heading', delay: 350 },
  { text: 'Analysing tool clarity...', tone: 'muted', delay: 500 },
  { text: '⚠ read_wiki_contents     5/10 — vague description', tone: 'fg', delay: 450 },
  { text: '⚠ Confusion detected: read_wiki_structure ↔', tone: 'fg', delay: 350 },
  { text: '  read_wiki_contents', tone: 'fg', delay: 300 },
  { text: '  "Both accept only repoName — agent cannot', tone: 'muted', delay: 350 },
  { text: '  distinguish topic-listing from content-retrieval"', tone: 'muted', delay: 400 },
  { text: '', tone: 'fg', delay: 200 },
  { text: 'Running 5 compatibility scenarios...', tone: 'muted', delay: 500 },
  { text: '✓ Scenario 1  ✓ Scenario 2  ✓ Scenario 3', tone: 'fg', delay: 300 },
  { text: '✓ Scenario 4  ✓ Scenario 5', tone: 'fg', delay: 300 },
  { text: '5/5 passed', tone: 'success', delay: 450 },
  { text: '', tone: 'fg', delay: 200 },
  { text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', tone: 'divider', delay: 150 },
  { text: 'Health Score: 89/100', tone: 'heading', delay: 350 },
  { text: 'Status: ⚠ Ready with Minor Improvements', tone: 'warning', delay: 400 },
  { text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', tone: 'divider', delay: 0 },
];

const HOLD_MS = 3000; // pause on the completed report before the loop resets

const LINE_TONE_CLASS: Record<LineTone, string> = {
  prompt: 'text-fg',
  muted: 'text-muted',
  fg: 'text-fg',
  success: 'text-success',
  warning: 'text-warning font-semibold',
  heading: 'text-fg font-semibold',
  divider: 'text-line',
};

// Splits on ✓ / ⚠ so those glyphs render in their semantic color while the
// rest of the line inherits whatever base tone the line container applies.
function renderSymbols(text: string) {
  if (!text) return ' ';
  return text.split(/(✓|⚠)/g).map((part, i) => {
    if (part === '✓') return <span key={i} className="text-success">✓</span>;
    if (part === '⚠') return <span key={i} className="text-warning">⚠</span>;
    return <span key={i}>{part}</span>;
  });
}

function TerminalDemo() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function run() {
      let acc = 0;
      DEMO_LINES.forEach((line, i) => {
        acc += line.delay;
        timeouts.push(setTimeout(() => { if (!cancelled) setVisible(i + 1); }, acc));
      });
      timeouts.push(setTimeout(() => {
        if (cancelled) return;
        setVisible(0);
        run();
      }, acc + HOLD_MS));
    }
    run();

    return () => { cancelled = true; timeouts.forEach(clearTimeout); };
  }, []);

  const typing = visible > 0 && visible < DEMO_LINES.length;

  return (
    <div className="rounded-lg border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-line bg-surface">
        <span className="w-2.5 h-2.5 rounded-full bg-critical/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-warning/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-success/70" />
        <span className="ml-2 text-[11px] text-muted font-mono">problex — zsh</span>
      </div>
      <div className="p-4 sm:p-5 font-mono text-[12px] sm:text-[13px] leading-5 min-h-[420px] sm:min-h-[400px]">
        {DEMO_LINES.slice(0, visible).map((line, i) => (
          <div key={i} className={`term-line whitespace-pre ${LINE_TONE_CLASS[line.tone]}`}>
            {line.tone === 'prompt' ? (
              <>
                <span className="text-success">$</span> <span>{line.text}</span>
              </>
            ) : (
              renderSymbols(line.text)
            )}
            {typing && i === visible - 1 && (
              <span className="inline-block w-[7px] h-[13px] bg-suggestion ml-1 align-middle animate-pulse" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Why Problex exists ─────────────────────────────────────────────────────

function WhyItExists() {
  return (
    <section className="max-w-2xl mx-auto px-6 py-16 text-center space-y-4">
      <p className="text-fg text-base sm:text-lg leading-relaxed">Most MCP servers technically work.</p>
      <p className="text-muted text-sm sm:text-base leading-relaxed">
        The difficult part is making sure AI agents consistently understand your tools, choose
        the correct one, and behave as intended.
      </p>
      <p className="text-muted text-sm sm:text-base leading-relaxed">
        Small description mistakes become production failures. Problex helps you find those
        issues before your users do.
      </p>
    </section>
  );
}

// ─── Three features ─────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: 'Protocol Validation',
    desc: 'Verify protocol compliance, schemas, parameters, and tool contracts.',
  },
  {
    title: 'Behavior Validation',
    desc: 'Detect ambiguous tools, confusing descriptions, and agent reasoning issues.',
  },
  {
    title: 'Compatibility Testing',
    desc: 'Simulate realistic prompts to discover routing mistakes before production.',
  },
];

function Features() {
  return (
    <section className="max-w-5xl mx-auto px-6 py-10">
      <div className="grid sm:grid-cols-3 gap-4">
        {FEATURES.map(f => (
          <div key={f.title} className="border border-line rounded-lg p-5 bg-surface">
            <h3 className="text-fg font-semibold text-sm mb-2">{f.title}</h3>
            <p className="text-muted text-sm leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Real report example ────────────────────────────────────────────────────

function ReportExample() {
  return (
    <section className="max-w-2xl mx-auto px-6 py-16">
      <h2 className="text-fg text-lg sm:text-xl font-semibold mb-1">Real finding on a live MCP server</h2>
      <p className="text-muted text-sm mb-6">
        Unedited excerpt from a Problex report — no synthetic examples.
      </p>

      <div className="bg-surface border border-line rounded-lg p-4 sm:p-5 space-y-4 font-mono text-xs sm:text-[13px]">
        <div className="flex items-center justify-between flex-wrap gap-2 pb-3 border-b border-line">
          <span className="text-fg">mcp.deepwiki.com <span className="text-muted">· 3 tools</span></span>
          <span className="text-fg font-bold">89<span className="text-muted font-normal">/100</span></span>
        </div>

        <div className="border-l-4 border-l-warning bg-canvas border border-line rounded p-3 space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-warning">⚠</span>
            <span className="text-fg">read_wiki_contents</span>
            <span className="text-warning font-bold">5/10</span>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted font-sans">Problem</div>
            <p className="text-fg/85 leading-snug mt-0.5">
              Missing the topic or page name parameter — an agent cannot specify which
              documentation page to read.
            </p>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted font-sans">Why this matters</div>
            <p className="text-muted leading-snug mt-0.5">
              Ambiguous descriptions raise the risk of wrong tool selection or malformed arguments.
            </p>
          </div>
        </div>

        <div className="border-l-4 border-l-warning bg-canvas border border-line rounded p-3 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted font-sans">Confusion detected</div>
          <div className="text-fg">read_wiki_structure <span className="text-muted">↔</span> read_wiki_contents</div>
          <p className="text-muted leading-snug">
            &ldquo;Both accept only repoName and mention documentation — an agent cannot
            distinguish between listing topics versus retrieving full content.&rdquo;
          </p>
        </div>

        <div className="border-l-4 border-l-success bg-canvas border border-line rounded p-3 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-success font-sans">Recommended fix</div>
          <p className="text-fg/85 leading-snug">
            &ldquo;Retrieves the full markdown content of a specific documentation page in a
            GitHub repository. Use this to read a page&rsquo;s complete content after calling
            read_wiki_structure to find available topic names.&rdquo;
          </p>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t border-line text-warning font-semibold font-sans">
          <span>⚠</span><span>Ready with Minor Improvements</span>
        </div>
      </div>
    </section>
  );
}

// ─── How it works ───────────────────────────────────────────────────────────

const STEPS = [
  { title: 'Paste MCP Server URL', desc: 'Point Problex at any public MCP server endpoint.' },
  { title: 'Automated validation runs', desc: 'Problex performs protocol, behavior, and compatibility validation.' },
  { title: 'Get an engineering report', desc: 'Receive a production-ready report with actionable fixes.' },
];

function HowItWorks() {
  return (
    <section className="max-w-4xl mx-auto px-6 py-16 border-t border-line">
      <div className="grid sm:grid-cols-3 gap-8 sm:gap-6">
        {STEPS.map((s, i) => (
          <div key={s.title}>
            <div className="text-suggestion font-mono text-xs mb-2">0{i + 1}</div>
            <h3 className="text-fg font-semibold text-sm mb-1.5">{s.title}</h3>
            <p className="text-muted text-sm leading-relaxed">{s.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Final CTA ──────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="border-t border-line">
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <h2 className="text-fg text-xl sm:text-2xl font-semibold mb-6">
          Ready to validate your MCP server?
        </h2>
        <Link
          href="/check"
          className="inline-block px-6 py-3 bg-suggestion hover:brightness-110 active:brightness-90
                     text-canvas font-semibold text-sm rounded transition-[filter]"
        >
          Validate Server →
        </Link>
        <p className="mt-4 text-[11px] text-muted/70">
          Free during Beta · No account required · 10 validations per hour
        </p>
      </div>
    </section>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="max-w-5xl mx-auto px-6 py-6 flex items-center justify-between flex-wrap gap-3">
        <span className="text-fg font-mono text-sm font-semibold">Problex</span>
        <div className="flex items-center gap-4 text-xs text-muted">
          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="hover:text-fg transition-colors">
            GitHub
          </a>
          <span className="text-line">·</span>
          <span>Privacy</span>
          <span className="text-line">·</span>
          <span>Terms</span>
        </div>
      </div>
      <div className="max-w-5xl mx-auto px-6 pb-6 text-[11px] text-muted/60">© 2026 Problex</div>
    </footer>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-canvas">
      <Navbar />
      <Hero />
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <TerminalDemo />
      </section>
      <WhyItExists />
      <Features />
      <ReportExample />
      <HowItWorks />
      <FinalCta />
      <Footer />
    </main>
  );
}
