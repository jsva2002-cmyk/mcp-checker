'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Layer1Report, Layer2Report, ClarityResult, ConfusionPair, SimulationResult, SuggestedFix, Severity } from '@/lib/types';

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

// ─── Severity ─────────────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<Severity, { emoji: string; label: string; cls: string }> = {
  critical:   { emoji: '🔴', label: 'Critical',   cls: 'bg-red-500/10 text-red-400 border-red-500/30' },
  warning:    { emoji: '🟡', label: 'Warning',    cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  suggestion: { emoji: '🔵', label: 'Suggestion', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
};

function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold
                      border uppercase tracking-wide whitespace-nowrap ${s.cls}`}>
      {s.emoji} {s.label}
    </span>
  );
}

// Left-edge accent so severity reads instantly without parsing text — red demands
// attention first, amber second, blue is informational, green confirms it's fine.
const SEVERITY_ACCENT: Record<Severity | 'ok', string> = {
  critical:   'border-l-red-500',
  warning:    'border-l-amber-500',
  suggestion: 'border-l-blue-500',
  ok:         'border-l-emerald-500',
};

// Wrong tool picked, or a protocol schema that doesn't validate — an agent
// calling this in production gets a wrong result or a hard error.
function schemaSeverity(passed: boolean): Severity | null {
  return passed ? null : 'critical';
}

// 7/10 is the line the backend itself draws for generating a fix (see
// CLARITY_FIX_THRESHOLD in layer2.ts) — below it is a Warning, exactly at it is
// a borderline Suggestion, above it isn't flagged at all.
function claritySeverity(score: number): Severity | null {
  const n = Math.round(score);
  if (n < 7) return 'warning';
  if (n === 7) return 'suggestion';
  return null;
}

function confusionSeverity(pair: ConfusionPair): Severity {
  return pair.severity === 'HIGH' ? 'warning' : 'suggestion';
}

function simulationSeverity(sim: SimulationResult): Severity | null {
  if (!sim.correct) return 'critical';
  if (sim.argWarning) return 'warning';
  return null;
}

// ─── Report-level summary ──────────────────────────────────────────────────────
// Single source of truth for the executive summary, the Layer 2 verdict banner,
// and the production verdict at the bottom — all three read from this so the
// numbers never drift from each other.

interface ReportSummary {
  protocolPassed: number;
  protocolTotal: number;
  behaviorLabel: 'Strong' | 'Moderate' | 'Weak' | 'Not run';
  compatibilityPassed: number;
  compatibilityTotal: number;
  clarityAverage: number | null;
  healthScore: number;
  criticalCount: number;
  schemaFailureCount: number;   // subset of criticalCount: Layer 1 schemas that failed
  scenarioFailureCount: number; // subset of criticalCount: scenarios where the wrong tool was picked
  warningCount: number;
  suggestionCount: number;
  improvementOpportunities: number;
  productionStatus: 'ready' | 'minor' | 'not-ready';
  highlights: string[];
  layer2Ran: boolean;
}

function computeReportSummary(layer1: Layer1Report, layer2: Layer2Report | null): ReportSummary {
  const protocolTotal = layer1.results.length;
  const protocolPassed = layer1.results.filter(r => r.schemaPassed).length;
  const protocolRate = protocolTotal > 0 ? protocolPassed / protocolTotal : 1;

  const layer2Ran = layer2 !== null;
  const compatibilityTotal = layer2?.simulation.length ?? 0;
  const compatibilityPassed = layer2?.simulationScore ?? 0;
  const compatibilityRate = compatibilityTotal > 0 ? compatibilityPassed / compatibilityTotal : 1;

  const clarityAverage = layer2 && layer2.clarity.length > 0
    ? layer2.clarity.reduce((sum, c) => sum + c.score, 0) / layer2.clarity.length
    : null;
  const clarityRate = clarityAverage !== null ? clarityAverage / 10 : 1;

  const behaviorLabel: ReportSummary['behaviorLabel'] =
    !layer2Ran || clarityAverage === null ? 'Not run' :
    clarityAverage >= 8 ? 'Strong' :
    clarityAverage >= 5 ? 'Moderate' : 'Weak';

  // Weighted per spec: protocol 30% + compatibility 40% + clarity 30%. When
  // Layer 2 hasn't run, only the protocol signal is known, so it carries the
  // full score rather than pretending the other two components are perfect.
  const healthScore = layer2Ran
    ? Math.round(protocolRate * 30 + compatibilityRate * 40 + clarityRate * 30)
    : Math.round(protocolRate * 100);

  const schemaFailureCount = protocolTotal - protocolPassed;
  const scenarioFailureCount = layer2 ? layer2.simulation.filter(s => !s.correct).length : 0;
  const criticalCount = schemaFailureCount + scenarioFailureCount;

  const lowClarityCount = layer2 ? layer2.clarity.filter(c => Math.round(c.score) < 7).length : 0;
  const highConfusionCount = layer2 ? layer2.confusedPairs.filter(p => p.severity === 'HIGH').length : 0;
  const argWarningCount = layer2 ? layer2.simulation.filter(s => s.correct && s.argWarning).length : 0;
  const warningCount = lowClarityCount + highConfusionCount + argWarningCount;

  const borderlineClarityCount = layer2 ? layer2.clarity.filter(c => Math.round(c.score) === 7).length : 0;
  const lowConfusionCount = layer2 ? layer2.confusedPairs.filter(p => p.severity === 'LOW').length : 0;
  const suggestionCount = borderlineClarityCount + lowConfusionCount;

  const improvementOpportunities = layer2?.verdict.issuesCount ?? 0;

  const productionStatus: ReportSummary['productionStatus'] =
    criticalCount > 0 ? 'not-ready' :
    warningCount > 0 ? 'minor' : 'ready';

  const schemaViolationCount = layer2 ? layer2.simulation.filter(s => s.argIssueType === 'schema').length : 0;
  const anyArgWarningCount = layer2 ? layer2.simulation.filter(s => s.argWarning).length : 0;

  const highlights: string[] = [];
  if (protocolTotal > 0 && protocolPassed === protocolTotal) {
    highlights.push('All protocol validation checks passed');
  }
  if (layer2Ran && compatibilityTotal > 0 && schemaViolationCount === 0) {
    highlights.push('No schema violations detected');
  }
  if (layer2Ran && compatibilityTotal > 0 && anyArgWarningCount === 0) {
    highlights.push('Strong parameter definitions');
  }

  return {
    protocolPassed, protocolTotal, behaviorLabel, compatibilityPassed, compatibilityTotal,
    clarityAverage, healthScore, criticalCount, schemaFailureCount, scenarioFailureCount,
    warningCount, suggestionCount, improvementOpportunities, productionStatus, highlights, layer2Ran,
  };
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

      <div className="space-y-3">
        {report.results.map((tool, i) => {
          const severity = schemaSeverity(tool.schemaPassed);
          const accent = SEVERITY_ACCENT[severity ?? 'ok'];
          return (
          <div key={tool.name}
            className={`border-l-4 ${accent} bg-slate-900 border-y border-r border-slate-800 rounded-r-xl p-4 hover:border-slate-700 transition-colors`}>
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
              <div className="flex flex-col items-end gap-1.5">
                <PassBadge passed={tool.schemaPassed} />
                {severity && <SeverityBadge severity={severity} />}
              </div>
            </div>
          </div>
          );
        })}
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

// Problem text: use Claude's own clarity verdict when the fix was triggered by a
// clarity issue. When it was triggered purely by a scenario failure on an
// otherwise clear-reading description, there's no "problem" verdict to reuse —
// state the actual, observed failure instead. One sentence — scan, don't read.
function problemText(fix: SuggestedFix, clarity?: ClarityResult): string {
  if (fix.reasons.includes('clarity') && clarity) return clarity.verdict;
  if (fix.scenarioContext) {
    return `Agent picked ${fix.scenarioContext.pickedTool} instead of this tool for a matching request.`;
  }
  return clarity?.verdict ?? 'Description needs clarification for reliable tool selection.';
}

// "Why this matters" is synthesized client-side from data already in the report —
// no extra model call — because it's just restating what the other checks found
// in terms of production consequence. One sentence.
function whyThisMattersText(fix: SuggestedFix): string {
  if (fix.reasons.includes('scenario')) {
    return 'In production, similar requests will silently route to the wrong tool.';
  }
  return 'Ambiguous descriptions raise the risk of wrong tool selection or malformed arguments.';
}

function SuggestedFixBox({ fix, clarity }: { fix: SuggestedFix; clarity?: ClarityResult }) {
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
    <div className="mt-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-4 space-y-3">
      <div>
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Problem</span>
        <p className="text-xs text-slate-300 leading-relaxed mt-1">{problemText(fix, clarity)}</p>
      </div>

      <div>
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Why this matters</span>
        <p className="text-xs text-slate-400 leading-relaxed mt-1">{whyThisMattersText(fix)}</p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wide">Recommended fix</span>
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
          <p className="text-xs text-emerald-400/70 leading-relaxed mt-2">
            Triggered by Scenario {fix.scenarioContext.scenarioIndex} — agent picked{' '}
            {fix.scenarioContext.pickedTool} instead of this tool.
          </p>
        )}
      </div>
    </div>
  );
}

function PassedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold
                     border uppercase tracking-wide whitespace-nowrap bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
      ✓ Passed
    </span>
  );
}

// Collapsible tool card: Tool name → Score + status → (expanded) Problem → Why
// this matters → Recommended fix → Copy → Triggered scenario. Passed tools
// collapse by default so a clean report scans in seconds; anything flagged
// opens automatically so it can't be missed.
function ToolCard({ result, fix }: { result: ClarityResult; fix?: SuggestedFix }) {
  const severity = claritySeverity(result.score);
  const [expanded, setExpanded] = useState(severity === 'warning');
  const accent = SEVERITY_ACCENT[severity ?? 'ok'];

  return (
    <div className={`border-l-4 ${accent} bg-slate-900 border-y border-r border-slate-800 rounded-r-xl overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-slate-800/30 transition-colors"
      >
        <ScoreBadge score={result.score} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-mono text-sm font-semibold text-slate-200">{result.name}</span>
            {severity ? <SeverityBadge severity={severity} /> : <PassedBadge />}
          </div>
          <p className={`text-xs text-slate-400 leading-relaxed ${expanded ? '' : 'truncate'}`}>{result.verdict}</p>
        </div>
        <span className="text-slate-600 text-xs mt-1.5 flex-shrink-0 select-none">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && fix && (
        <div className="px-4 pb-4">
          <SuggestedFixBox fix={fix} clarity={result} />
        </div>
      )}
    </div>
  );
}

function ConfusionRow({ pair }: { pair: ConfusionPair }) {
  const isHigh = pair.severity === 'HIGH';
  const severity = confusionSeverity(pair);
  const accent = SEVERITY_ACCENT[severity];
  return (
    <div className={`border-l-4 ${accent} border-y border-r border-slate-800 rounded-r-xl p-4 ${
      isHigh ? 'bg-amber-500/5' : 'bg-blue-500/5'
    }`}>
      <div className="flex items-center gap-2 mb-2 text-sm font-mono flex-wrap">
        <span className={`font-semibold ${isHigh ? 'text-amber-300' : 'text-blue-300'}`}>{pair.tool1}</span>
        <span className="text-slate-500">↔</span>
        <span className={`font-semibold ${isHigh ? 'text-amber-300' : 'text-blue-300'}`}>{pair.tool2}</span>
        <SeverityBadge severity={severity} />
        {isHigh && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300
                           font-sans font-semibold uppercase tracking-wide whitespace-nowrap">
            Confirmed by simulation
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{pair.reason}</p>
      {isHigh && pair.confirmedByScenario && (
        <p className="text-xs text-amber-300/80 leading-relaxed mt-1.5">
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
  const severity = simulationSeverity(sim);
  const accent = SEVERITY_ACCENT[severity ?? 'ok'];
  return (
    <div className={`border-l-4 ${accent} bg-slate-900 border-y border-r border-slate-800 rounded-r-xl p-4`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <div className="text-xs text-slate-500 font-mono">Scenario {index + 1}</div>
          {severity && <SeverityBadge severity={severity} />}
        </div>
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

function VerdictBanner({ summary }: { summary: ReportSummary }) {
  if (summary.productionStatus === 'ready') {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-2">
        <span className="text-emerald-400 text-lg leading-none">✓</span>
        <span className="text-emerald-300 font-semibold text-sm">Server ready to ship</span>
      </div>
    );
  }

  const notReady = summary.productionStatus === 'not-ready';
  const opportunityWord = summary.improvementOpportunities === 1 ? 'improvement opportunity' : 'improvement opportunities';
  const criticalText = summary.criticalCount > 0
    ? `${summary.criticalCount} critical failure${summary.criticalCount === 1 ? '' : 's'}`
    : 'No critical failures';
  const headline = notReady
    ? `${summary.criticalCount} critical issue${summary.criticalCount === 1 ? '' : 's'} found before shipping`
    : `${summary.improvementOpportunities} ${opportunityWord} found before shipping`;

  return (
    <div className={`rounded-xl p-4 border ${
      notReady ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'
    }`}>
      <div className={`font-semibold text-sm mb-1 ${notReady ? 'text-red-300' : 'text-amber-300'}`}>
        {headline}
      </div>
      <div className={`text-xs ${notReady ? 'text-red-200/70' : 'text-amber-200/70'}`}>
        {summary.protocolPassed}/{summary.protocolTotal} Protocol checks passed · {summary.compatibilityPassed}/{summary.compatibilityTotal} Compatibility scenarios passed
        {' '}· {summary.improvementOpportunities} {opportunityWord} · {criticalText}
      </div>
    </div>
  );
}

// ─── Executive summary (top) & production verdict (bottom) ───────────────────

const PRODUCTION_STATUS_STYLE: Record<ReportSummary['productionStatus'], { emoji: string; label: string; cls: string }> = {
  ready:      { emoji: '✅', label: 'Ready for Production',            cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  minor:      { emoji: '⚠',  label: 'Ready with Minor Improvements',   cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  'not-ready':{ emoji: '❌', label: 'Not Ready',                       cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

function ProductionStatusBadge({ status }: { status: ReportSummary['productionStatus'] }) {
  const s = PRODUCTION_STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${s.cls}`}>
      {s.emoji} {s.label}
    </span>
  );
}

// Compact bar pinned to the top of the viewport once the page scrolls past the
// header, so health/severity context stays visible through a long report.
function StickySummaryBar({ summary }: { summary: ReportSummary }) {
  const s = PRODUCTION_STATUS_STYLE[summary.productionStatus];
  return (
    <div className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur border-b border-slate-800">
      <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center gap-4 text-xs overflow-x-auto">
        <span className="font-bold text-slate-200 whitespace-nowrap">
          {summary.healthScore}<span className="text-slate-500 font-normal">/100</span>
        </span>
        <span className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap ${
          summary.productionStatus === 'ready' ? 'text-emerald-300' :
          summary.productionStatus === 'minor' ? 'text-amber-300' : 'text-red-300'
        }`}>
          {s.emoji} {s.label}
        </span>
        <span className="text-red-400 whitespace-nowrap">🔴 {summary.criticalCount}</span>
        <span className="text-amber-400 whitespace-nowrap">🟡 {summary.warningCount}</span>
        <span className="text-blue-400 whitespace-nowrap">🔵 {summary.suggestionCount}</span>
      </div>
    </div>
  );
}

function HealthScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 80 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' :
    score >= 50 ? 'text-amber-400 border-amber-500/30 bg-amber-500/10' :
                  'text-red-400 border-red-500/30 bg-red-500/10';
  return (
    <div className={`flex flex-col items-center justify-center w-20 h-20 rounded-2xl border flex-shrink-0 ${cls}`}>
      <span className="text-2xl font-bold leading-none">{score}</span>
      <span className="text-[9px] uppercase tracking-wide mt-1 opacity-80">Health</span>
    </div>
  );
}

function StatRow({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const cls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-slate-200';
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-semibold ${cls}`}>{value}</span>
    </div>
  );
}

// "██████████░░ 8/12 Passed"-style bar — a filled track sized to the pass rate,
// so protocol/behavior/compatibility health reads at a glance, not just as a fraction.
function ProgressBar({ fraction, tone }: { fraction: number; tone: 'good' | 'bad' | 'neutral' }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const barCls = tone === 'good' ? 'bg-emerald-400' : tone === 'bad' ? 'bg-red-400' : 'bg-amber-400';
  return (
    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
      <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatBarRow({ label, value, fraction, tone }: { label: string; value: string; fraction: number; tone: 'good' | 'bad' | 'neutral' }) {
  const cls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-slate-200';
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-slate-500">{label}</span>
        <span className={`text-xs font-semibold ${cls}`}>{value}</span>
      </div>
      <ProgressBar fraction={fraction} tone={tone} />
    </div>
  );
}

function ExecutiveSummary({ summary }: { summary: ReportSummary }) {
  const protocolOk = summary.protocolTotal > 0 && summary.protocolPassed === summary.protocolTotal;
  const behaviorTone = summary.behaviorLabel === 'Strong' ? 'good' : summary.behaviorLabel === 'Weak' ? 'bad' : 'neutral';
  const compatibilityOk = summary.layer2Ran && summary.compatibilityTotal > 0 && summary.compatibilityPassed === summary.compatibilityTotal;

  const protocolFraction = summary.protocolTotal > 0 ? summary.protocolPassed / summary.protocolTotal : 1;
  const compatibilityFraction = summary.compatibilityTotal > 0 ? summary.compatibilityPassed / summary.compatibilityTotal : 0;
  const behaviorFraction = summary.clarityAverage !== null ? summary.clarityAverage / 10 : 0;
  const behaviorValue = summary.clarityAverage !== null
    ? `${summary.behaviorLabel} (${summary.clarityAverage.toFixed(1)}/10)`
    : summary.behaviorLabel;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
      <div className="flex items-start gap-4 mb-6">
        <HealthScoreBadge score={summary.healthScore} />
        <div className="flex-1 min-w-0 pt-1">
          <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wide mb-2.5">Executive Summary</h2>
          <ProductionStatusBadge status={summary.productionStatus} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-8">
        <div>
          <StatBarRow
            label="Protocol Validation"
            value={`${summary.protocolPassed}/${summary.protocolTotal} Passed`}
            fraction={protocolFraction}
            tone={protocolOk ? 'good' : 'bad'}
          />
          <StatBarRow
            label="Behavior Validation"
            value={behaviorValue}
            fraction={summary.layer2Ran ? behaviorFraction : 0}
            tone={summary.layer2Ran ? behaviorTone : 'neutral'}
          />
          <StatBarRow
            label="Compatibility Testing"
            value={summary.layer2Ran ? `${summary.compatibilityPassed}/${summary.compatibilityTotal} Passed` : 'Not run'}
            fraction={summary.layer2Ran ? compatibilityFraction : 0}
            tone={summary.layer2Ran ? (compatibilityOk ? 'good' : 'neutral') : 'neutral'}
          />
        </div>
        <div>
          <StatRow label="Critical Issues" value={String(summary.criticalCount)} tone={summary.criticalCount > 0 ? 'bad' : 'good'} />
          <StatRow label="Warnings" value={String(summary.warningCount)} tone={summary.warningCount > 0 ? 'neutral' : 'good'} />
          <StatRow label="Suggestions" value={String(summary.suggestionCount)} />
        </div>
      </div>

      {summary.highlights.length > 0 && (
        <div className="mt-5 pt-5 border-t border-slate-800 space-y-1.5">
          {summary.highlights.map(h => (
            <div key={h} className="text-xs text-emerald-400 flex items-center gap-1.5">
              <span>✓</span><span>{h}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// 3-4 sentence explanation of exactly why the production verdict landed where it
// did — built from the same counts shown above it, not a separate judgment call.
function verdictExplanation(summary: ReportSummary): string[] {
  const lines: string[] = [];

  if (summary.productionStatus === 'ready') {
    lines.push(
      `All ${summary.protocolTotal} protocol check${summary.protocolTotal === 1 ? '' : 's'} passed, and the agent picked the correct tool in ` +
      `${summary.compatibilityPassed}/${summary.compatibilityTotal} compatibility scenarios${summary.layer2Ran ? '' : ' (behavior validation was not run)'}.`,
    );
    if (summary.clarityAverage !== null) {
      lines.push(`Clarity scores average ${summary.clarityAverage.toFixed(1)}/10 with no confirmed ambiguous tool pairs.`);
    }
    lines.push('No critical issues or warnings were found in this run — this server is safe to ship as-is.');
    return lines;
  }

  if (summary.productionStatus === 'minor') {
    lines.push(
      `Protocol validation and tool selection are solid: ${summary.protocolPassed}/${summary.protocolTotal} schemas valid, ` +
      `${summary.compatibilityPassed}/${summary.compatibilityTotal} compatibility scenarios correct.`,
    );
    lines.push(
      `${summary.warningCount} warning${summary.warningCount === 1 ? '' : 's'} — low-clarity descriptions, confirmed ambiguous ` +
      `tool pairs, or argument-quality issues — should be addressed before scaling usage.`,
    );
    lines.push('None of these block shipping today, but they are the most likely source of an agent picking the wrong tool under different phrasing.');
    return lines;
  }

  const criticalParts: string[] = [];
  if (summary.schemaFailureCount > 0) {
    criticalParts.push(`${summary.schemaFailureCount} failed protocol schema${summary.schemaFailureCount === 1 ? '' : 's'}`);
  }
  if (summary.scenarioFailureCount > 0) {
    criticalParts.push(`${summary.scenarioFailureCount} scenario${summary.scenarioFailureCount === 1 ? '' : 's'} where the agent picked the wrong tool`);
  }
  lines.push(
    `${summary.criticalCount} critical issue${summary.criticalCount === 1 ? '' : 's'} — ${criticalParts.join(' and ')} — ` +
    `mean this server will misroute real requests.`,
  );
  lines.push(
    `${summary.protocolPassed}/${summary.protocolTotal} protocol checks passed and ${summary.compatibilityPassed}/${summary.compatibilityTotal} ` +
    `compatibility scenarios were handled correctly.`,
  );
  if (summary.warningCount > 0) {
    lines.push(`${summary.warningCount} additional warning${summary.warningCount === 1 ? '' : 's'} should be fixed once the critical issues are resolved.`);
  }
  lines.push('Fix the critical issues above before shipping this server.');
  return lines;
}

function ProductionVerdict({ summary }: { summary: ReportSummary }) {
  const s = PRODUCTION_STATUS_STYLE[summary.productionStatus];
  const lines = verdictExplanation(summary);

  return (
    <section className={`rounded-2xl border p-6 ${s.cls}`}>
      <div className="flex items-center gap-2 text-base font-bold mb-4">
        <span>{s.emoji}</span><span>{s.label}</span>
      </div>
      <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
        {lines.map((line, i) => <p key={i}>{line}</p>)}
      </div>
    </section>
  );
}

function Layer2Section({ report, summary }: { report: Layer2Report; summary: ReportSummary }) {
  const simTotal = report.simulation.length;
  const simPassed = report.simulationScore;
  const fixByName = new Map(report.suggestedFixes.map(f => [f.name, f]));
  const showConfusionCaveat = report.confusedPairs.length > 0 && simTotal > 0 && simPassed === simTotal;

  return (
    <section className="space-y-10">
      <VerdictBanner summary={summary} />

      <SectionHeader title="Layer 2 · Behavior Validation" />

      {/* Check 1: Clarity */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
          Check 1 · Clarity Analysis
        </h3>
        <div className="space-y-3">
          {report.clarity.map(r => <ToolCard key={r.name} result={r} fix={fixByName.get(r.name)} />)}
        </div>
      </div>

      {/* Check 2: Confusion */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
          Check 2 · Ambiguity Analysis
        </h3>
        {report.confusedPairs.length === 0 ? (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 text-emerald-400 text-sm">
            ✓ No confused tool pairs detected.
          </div>
        ) : (
          <div className="space-y-3">
            {report.confusedPairs.map((pair, i) => <ConfusionRow key={i} pair={pair} />)}
          </div>
        )}
      </div>

      {/* Check 3: Simulation */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-3">
          Check 3 · Compatibility Testing
          <span className={`normal-case text-sm font-bold ${
            simPassed === simTotal ? 'text-emerald-400' :
            simPassed >= Math.ceil(simTotal / 2) ? 'text-amber-400' :
            'text-red-400'
          }`}>
            {simPassed}/{simTotal} passed
          </span>
        </h3>
        <p className="text-xs text-slate-600 mb-4 normal-case">
          Agent simulation run at fixed temperature for reproducible results.
        </p>
        {showConfusionCaveat && (
          <p className="text-xs text-slate-500 leading-relaxed mb-4 normal-case">
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

  // Wait for Layer 2 (success or failure) before computing the summary when AI
  // checks were requested, so "Behavior Validation: Not run" doesn't flash
  // briefly while the request is still in flight.
  const summaryReady = layer1 !== null && !layer1Loading && (!runAi || layer2 !== null || layer2Error !== null);
  const summary = summaryReady && layer1 ? computeReportSummary(layer1, layer2) : null;

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

      {summary && <StickySummaryBar summary={summary} />}

      <main className="max-w-2xl mx-auto px-4 py-10 space-y-12">
        {/* Executive summary dashboard — leads the whole report */}
        {summary && <ExecutiveSummary summary={summary} />}

        {/* Server info + Layer 1 are grouped tightly — the info line is Layer 1's intro, not its own section */}
        <div className="space-y-4">
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

          {layer1Loading && <Layer1Skeleton />}
          {layer1Error && !layer1 && !layer1Loading && (
            <ErrorBox message={layer1Error} defaultHeader="Connection failed" />
          )}
          {layer1 && !layer1Loading && <Layer1Section report={layer1} />}
        </div>

        {/* Layer 2 */}
        {layer2Loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <Spinner label="Running behavior validation (Layer 2)… this may take up to 30 s" />
          </div>
        )}
        {layer2Error && (
          <ErrorBox message={layer2Error} defaultHeader="Layer 2 failed" />
        )}
        {layer2 && summary && <Layer2Section report={layer2} summary={summary} />}

        {/* Production verdict — closes out the report */}
        {summary && <ProductionVerdict summary={summary} />}

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
