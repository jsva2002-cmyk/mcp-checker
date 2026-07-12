'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Layer1Report, Layer2Report, Layer2Verdict, ClarityResult, ConfusionPair, SimulationResult, SuggestedFix } from '@/lib/types';

// ─── Small shared atoms ───────────────────────────────────────────────────────

function PassBadge({ passed }: { passed: boolean }) {
  return passed ? (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-500/10 text-emerald-400
                     border border-emerald-500/30 rounded-full text-xs font-semibold whitespace-nowrap">
      ✓ PASSED
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-500/10 text-red-400
                     border border-red-500/30 rounded-full text-xs font-semibold whitespace-nowrap">
      ✗ FAILED
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const n = Math.round(score);
  const cls =
    n >= 8 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' :
    n >= 5 ? 'text-amber-400  bg-amber-500/10  border-amber-500/30' :
             'text-red-400    bg-red-500/10    border-red-500/30';
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-sm font-bold border ${cls}`}>
      {n}/10
    </span>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-slate-800 rounded-lg ${className ?? ''}`} />;
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-400 text-sm py-2">
      <svg className="animate-spin h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {label}
    </div>
  );
}

const RATE_LIMIT_MESSAGE = "You've reached the limit of 10 checks per hour. Please wait before running another check.";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function friendlyErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) return RATE_LIMIT_MESSAGE;
  return e instanceof Error ? e.message : 'Failed to connect';
}

function ErrorBox({ message, defaultHeader }: { message: string; defaultHeader: string }) {
  const isRateLimit = message === RATE_LIMIT_MESSAGE;
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
      <div className="font-semibold mb-1">{isRateLimit ? 'Rate limit reached' : defaultHeader}</div>
      {message}
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold text-slate-200 tracking-wide uppercase text-xs">{title}</h2>
      {badge}
      <div className="flex-1 h-px bg-slate-800" />
    </div>
  );
}

// ─── Layer 1 display ──────────────────────────────────────────────────────────

function Layer1Section({ report }: { report: Layer1Report }) {
  const passed = report.results.filter(r => r.schemaPassed).length;
  const failed = report.results.length - passed;

  return (
    <section>
      <SectionHeader
        title="Layer 1 · Protocol Validation"
        badge={
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            failed === 0
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
              : 'bg-red-500/10 text-red-400 border border-red-500/30'
          }`}>
            {passed}/{report.results.length} passed
          </span>
        }
      />

      {report.noToolsCapability && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-amber-300 text-sm">
          This server does not advertise tool support.
        </div>
      )}

      <div className="space-y-2">
        {report.results.map((tool, i) => (
          <div key={tool.name}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-slate-600 font-mono">[{i + 1}/{report.results.length}]</span>
                  <span className="font-semibold text-slate-100 font-mono text-sm">{tool.name}</span>
                  {tool.title && tool.title !== tool.name && (
                    <span className="text-xs text-slate-500 truncate">· {tool.title}</span>
                  )}
                </div>
                {tool.description && (
                  <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{tool.description}</p>
                )}
                {tool.schemaErrors && tool.schemaErrors.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {tool.schemaErrors.map((err, ei) => (
                      <li key={ei} className="text-xs text-red-400 font-mono">{err}</li>
                    ))}
                  </ul>
                )}
              </div>
              <PassBadge passed={tool.schemaPassed} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Layer1Skeleton() {
  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <Skeleton className="h-3 w-40" />
        <div className="flex-1 h-px bg-slate-800" />
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-60" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Layer 2 display ──────────────────────────────────────────────────────────

function SuggestedFixBox({ fix }: { fix: SuggestedFix }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fix.suggestedDescription);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied — nothing to do, text is still selectable
    }
  };

  return (
    <div className="mt-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Recommended fix</span>
        <button
          onClick={copy}
          className="text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-300
                     hover:bg-emerald-500/10 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-emerald-200/90 leading-relaxed">{fix.suggestedDescription}</p>
      {fix.scenarioContext && (
        <p className="text-xs text-emerald-400/70 leading-relaxed mt-1.5">
          Triggered by Scenario {fix.scenarioContext.scenarioIndex} — agent picked{' '}
          {fix.scenarioContext.pickedTool} instead of this tool.
        </p>
      )}
    </div>
  );
}

function ClarityRow({ result, fix }: { result: ClarityResult; fix?: SuggestedFix }) {
  return (
    <div className="py-3 border-b border-slate-800 last:border-0">
      <div className="flex items-start gap-3">
        <ScoreBadge score={result.score} />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-slate-200 mb-0.5">{result.name}</div>
          <div className="text-xs text-slate-400 leading-relaxed">{result.verdict}</div>
        </div>
      </div>
      {fix && <SuggestedFixBox fix={fix} />}
    </div>
  );
}

function ConfusionRow({ pair }: { pair: ConfusionPair }) {
  const isHigh = pair.severity === 'HIGH';
  return (
    <div className={`rounded-xl p-3 border ${
      isHigh ? 'bg-red-500/5 border-red-500/20' : 'bg-amber-500/5 border-amber-500/20'
    }`}>
      <div className="flex items-center gap-2 mb-1.5 text-sm font-mono flex-wrap">
        <span className={`font-semibold ${isHigh ? 'text-red-300' : 'text-amber-300'}`}>{pair.tool1}</span>
        <span className="text-slate-500">↔</span>
        <span className={`font-semibold ${isHigh ? 'text-red-300' : 'text-amber-300'}`}>{pair.tool2}</span>
        {isHigh && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-300
                           font-sans font-semibold uppercase tracking-wide whitespace-nowrap">
            Confirmed by simulation
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{pair.reason}</p>
      {isHigh && pair.confirmedByScenario && (
        <p className="text-xs text-red-300/80 leading-relaxed mt-1">
          Confirmed by Scenario {pair.confirmedByScenario} — agent picked {pair.confirmedByPickedTool} instead.
        </p>
      )}
    </div>
  );
}

function SimStatusBadge({ sim }: { sim: SimulationResult }) {
  if (!sim.correct) {
    return <span className="text-red-400 text-base leading-none">✗</span>;
  }
  if (sim.argWarning) {
    const label = sim.argIssueType === 'schema' ? 'PASS (schema violation)' : 'PASS (wrong args)';
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
                       bg-amber-500/10 text-amber-400 border border-amber-500/30 whitespace-nowrap">
        ⚠ {label}
      </span>
    );
  }
  return <span className="text-emerald-400 text-base leading-none">✓</span>;
}

function SimulationRow({ sim, index }: { sim: SimulationResult; index: number }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="text-xs text-slate-500 font-mono">Scenario {index + 1}</div>
        <SimStatusBadge sim={sim} />
      </div>
      <p className="text-sm text-slate-300 mb-3 leading-relaxed">&ldquo;{sim.request}&rdquo;</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-slate-500 mb-1">Expected</div>
          <div className="font-mono text-slate-300 bg-slate-800 px-2 py-1 rounded">{sim.expectedTool}</div>
        </div>
        <div>
          <div className="text-slate-500 mb-1">Picked</div>
          <div className={`font-mono px-2 py-1 rounded ${
            sim.correct ? 'text-emerald-300 bg-emerald-500/10' : 'text-red-300 bg-red-500/10'
          }`}>{sim.pickedTool}</div>
        </div>
      </div>
      {Object.keys(sim.pickedArgs).length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-slate-500 mb-1">Args</div>
          <pre className="text-xs text-slate-400 bg-slate-800 px-2 py-1.5 rounded overflow-x-auto">
            {JSON.stringify(sim.pickedArgs, null, 2)}
          </pre>
        </div>
      )}
      {sim.argWarning && sim.argIssue && (
        <p className="text-xs text-amber-300/90 leading-relaxed mt-2">
          <span className="font-semibold uppercase tracking-wide text-[10px] text-amber-400/80 mr-1">
            {sim.argIssueType === 'schema' ? 'Schema violation (programmatic):' : 'Value quality warning (heuristic):'}
          </span>
          {sim.argIssue}
        </p>
      )}
    </div>
  );
}

function VerdictBanner({ verdict }: { verdict: Layer2Verdict }) {
  if (verdict.shipReady) {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-2">
        <span className="text-emerald-400 text-lg leading-none">✓</span>
        <span className="text-emerald-300 font-semibold text-sm">Server ready to ship</span>
      </div>
    );
  }

  const issueWord = verdict.issuesCount === 1 ? 'issue' : 'issues';
  const scenarioWord = verdict.scenariosFailed === 1 ? 'scenario' : 'scenarios';

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
      <div className="text-amber-300 font-semibold text-sm mb-1">
        {verdict.issuesCount} {issueWord} found before shipping
      </div>
      <div className="text-xs text-amber-200/70">
        {verdict.readyTools}/{verdict.totalTools} tools ready to ship · {verdict.scenariosFailed} {scenarioWord} failed
        {' '}· {verdict.issuesCount} {issueWord} need fixing
      </div>
    </div>
  );
}

function Layer2Section({ report }: { report: Layer2Report }) {
  const simTotal = report.simulation.length;
  const simPassed = report.simulationScore;
  const fixByName = new Map(report.suggestedFixes.map(f => [f.name, f]));
  const showConfusionCaveat = report.confusedPairs.length > 0 && simTotal > 0 && simPassed === simTotal;

  return (
    <section className="space-y-6">
      <VerdictBanner verdict={report.verdict} />

      <SectionHeader title="Layer 2 · Behavior Validation" />

      {/* Check 1: Clarity */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
          Check 1 · Clarity Analysis
        </h3>
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 divide-y divide-slate-800">
          {report.clarity.map(r => <ClarityRow key={r.name} result={r} fix={fixByName.get(r.name)} />)}
        </div>
      </div>

      {/* Check 2: Confusion */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
          Check 2 · Ambiguity Analysis
        </h3>
        {report.confusedPairs.length === 0 ? (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 text-emerald-400 text-sm">
            ✓ No confused tool pairs detected.
          </div>
        ) : (
          <div className="space-y-2">
            {report.confusedPairs.map((pair, i) => <ConfusionRow key={i} pair={pair} />)}
          </div>
        )}
      </div>

      {/* Check 3: Simulation */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-3">
          Check 3 · Compatibility Testing
          <span className={`normal-case text-sm font-bold ${
            simPassed === simTotal ? 'text-emerald-400' :
            simPassed >= Math.ceil(simTotal / 2) ? 'text-amber-400' :
            'text-red-400'
          }`}>
            {simPassed}/{simTotal} passed
          </span>
        </h3>
        <p className="text-xs text-slate-600 mb-3 normal-case">
          Agent simulation run at fixed temperature for reproducible results.
        </p>
        {showConfusionCaveat && (
          <p className="text-xs text-slate-500 leading-relaxed mb-3 normal-case">
            {simPassed}/{simTotal} passed on this run — confusion risk flagged above may surface on
            different user phrasings. Scenario simulation is one sample; confusion detection identifies
            structural risk regardless of this run&rsquo;s outcome.
          </p>
        )}
        <div className="space-y-3">
          {report.simulation.map((sim, i) => <SimulationRow key={i} sim={sim} index={i} />)}
        </div>
      </div>
    </section>
  );
}

// ─── Main results content ─────────────────────────────────────────────────────

function ResultsContent() {
  const params = useSearchParams();
  const router = useRouter();

  const url  = params.get('url') ?? '';
  const runAi = params.get('ai') === 'true';

  const [layer1, setLayer1]             = useState<Layer1Report | null>(null);
  const [layer1Loading, setLayer1Loading] = useState(true);
  const [layer1Error, setLayer1Error]   = useState<string | null>(null);

  const [layer2, setLayer2]             = useState<Layer2Report | null>(null);
  const [layer2Loading, setLayer2Loading] = useState(false);
  const [layer2Error, setLayer2Error]   = useState<string | null>(null);

  useEffect(() => {
    if (!url) { router.push('/'); return; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let cleanedUp = false;

    setLayer1Loading(true);
    setLayer1Error(null);

    fetch('/api/check', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
      signal:  controller.signal,
    })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new ApiError((data as { error: string }).error ?? `HTTP ${r.status}`, r.status);
        return data as Layer1Report;
      })
      .then(data => {
        clearTimeout(timer);
        setLayer1(data);
        setLayer1Loading(false);

        if (runAi && data.tools.length > 0) {
          setLayer2Loading(true);
          fetch('/api/check-ai', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ tools: data.tools }),
          })
            .then(async r => {
              const d = await r.json();
              if (!r.ok) throw new ApiError((d as { error: string }).error ?? `HTTP ${r.status}`, r.status);
              return d as Layer2Report;
            })
            .then(d => { setLayer2(d); setLayer2Loading(false); })
            .catch(e => { setLayer2Error(friendlyErrorMessage(e)); setLayer2Loading(false); });
        }
      })
      .catch(e => {
        clearTimeout(timer);
        // Ignore aborts caused by the effect cleanup (e.g. React Strict Mode double-invoke).
        // Only update state for real failures: HTTP errors or the 60 s timeout firing.
        if (cleanedUp) return;
        setLayer1Error(
          e.name === 'AbortError'
            ? 'Connection timed out after 60 s'
            : friendlyErrorMessage(e),
        );
        setLayer1Loading(false);
      });

    return () => { cleanedUp = true; controller.abort(); clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, runAi]);

  const hostname = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Top bar */}
      <header className="border-b border-slate-800 px-4 py-3 flex items-center gap-4">
        <Link href="/"
          className="text-slate-400 hover:text-slate-100 transition-colors text-sm flex items-center gap-1">
          ← Back
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-slate-500">Checking</span>
          <span className="font-mono text-sm text-blue-400 truncate">{hostname}</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* Server info (once loaded) */}
        {layer1 && !layer1Loading && (
          <div className="flex items-center gap-3 text-sm">
            <span className="w-2 h-2 bg-emerald-400 rounded-full flex-shrink-0" />
            {layer1.serverName ? (
              <span className="text-slate-300">
                <span className="font-semibold">{layer1.serverName}</span>
                {layer1.serverVersion && <span className="text-slate-500"> v{layer1.serverVersion}</span>}
                <span className="text-slate-500"> · {layer1.toolCount} tool{layer1.toolCount !== 1 ? 's' : ''}</span>
              </span>
            ) : (
              <span className="text-slate-400">{layer1.toolCount} tool{layer1.toolCount !== 1 ? 's' : ''} found</span>
            )}
          </div>
        )}

        {/* Layer 1 */}
        {layer1Loading && <Layer1Skeleton />}
        {layer1Error && !layer1 && !layer1Loading && (
          <ErrorBox message={layer1Error} defaultHeader="Connection failed" />
        )}
        {layer1 && !layer1Loading && <Layer1Section report={layer1} />}

        {/* Layer 2 */}
        {layer2Loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <Spinner label="Running behavior validation (Layer 2)… this may take up to 30 s" />
          </div>
        )}
        {layer2Error && (
          <ErrorBox message={layer2Error} defaultHeader="Layer 2 failed" />
        )}
        {layer2 && <Layer2Section report={layer2} />}

        {/* Check another */}
        {!layer1Loading && (
          <div className="pt-4 border-t border-slate-800">
            <Link href="/"
              className="text-sm text-slate-400 hover:text-slate-100 transition-colors">
              ← Check another server
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    }>
      <ResultsContent />
    </Suspense>
  );
}
