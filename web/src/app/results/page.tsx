'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Layer1Report, Layer2Report, ClarityResult, ConfusionPair, SimulationResult, SuggestedFix, Severity, ToolSchemaResult } from '@/lib/types';

// ─── Small shared atoms ───────────────────────────────────────────────────────

function PassBadge({ passed }: { passed: boolean }) {
  return passed ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-success/10 text-success
                     border border-success/30 rounded text-[10px] font-mono font-semibold whitespace-nowrap">
      PASSED
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-critical/10 text-critical
                     border border-critical/30 rounded text-[10px] font-mono font-semibold whitespace-nowrap">
      FAILED
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const n = Math.round(score);
  const cls =
    n >= 8 ? 'text-success border-success/30' :
    n >= 5 ? 'text-warning border-warning/30' :
             'text-critical border-critical/30';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono font-bold border ${cls}`}>
      {n}/10
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-muted text-sm py-2">
      <svg className="animate-spin h-4 w-4 text-suggestion" fill="none" viewBox="0 0 24 24">
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
    <div className="bg-surface border border-line border-l-4 border-l-critical rounded p-3 text-sm">
      <div className="font-semibold mb-1 text-critical">{isRateLimit ? 'Rate limit reached' : defaultHeader}</div>
      <div className="text-fg/80">{message}</div>
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <h2 className="text-[11px] font-semibold text-muted tracking-wider uppercase">{title}</h2>
      {badge}
      <div className="flex-1 h-px bg-line" />
    </div>
  );
}

// ─── Severity ─────────────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<Severity, { emoji: string; label: string; cls: string }> = {
  critical:   { emoji: '🔴', label: 'Critical',   cls: 'bg-critical/10 text-critical border-critical/30' },
  warning:    { emoji: '🟡', label: 'Warning',    cls: 'bg-warning/10 text-warning border-warning/30' },
  suggestion: { emoji: '🔵', label: 'Suggestion', cls: 'bg-suggestion/10 text-suggestion border-suggestion/30' },
};

function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium
                      border whitespace-nowrap ${s.cls}`}>
      {s.emoji} {s.label}
    </span>
  );
}

// Left-edge accent so severity reads instantly without parsing text — red demands
// attention first, amber second, blue is informational, green confirms it's fine.
const SEVERITY_ACCENT: Record<Severity | 'ok', string> = {
  critical:   'border-l-critical',
  warning:    'border-l-warning',
  suggestion: 'border-l-suggestion',
  ok:         'border-l-success',
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

// Collapsed: index + name + PASS/FAIL badge on one line. Expanded: title,
// description, schema errors. Failed tools expand by default; passed tools
// collapse so a clean report scans in seconds.
function Layer1ToolRow({ tool, index, total, expanded, onToggle }: {
  tool: ToolSchemaResult; index: number; total: number; expanded: boolean; onToggle: () => void;
}) {
  const severity = schemaSeverity(tool.schemaPassed);
  const accent = SEVERITY_ACCENT[severity ?? 'ok'];

  return (
    <div className={`border-l-4 ${accent} bg-surface border-y border-r border-line rounded overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-line/20 transition-colors"
      >
        <span className="text-[10px] text-muted font-mono flex-shrink-0">[{index + 1}/{total}]</span>
        <span className="font-mono text-sm text-fg flex-1 min-w-0 truncate text-left">{tool.name}</span>
        <PassBadge passed={tool.schemaPassed} />
        {severity && <SeverityBadge severity={severity} />}
        <span className="text-muted text-[10px] flex-shrink-0 select-none font-mono">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-line pt-2 space-y-1.5">
          {tool.title && tool.title !== tool.name && (
            <div className="text-xs text-muted">{tool.title}</div>
          )}
          {tool.description && (
            <p className="text-xs text-muted leading-snug">{tool.description}</p>
          )}
          {tool.schemaErrors && tool.schemaErrors.length > 0 && (
            <ul className="space-y-0.5">
              {tool.schemaErrors.map((err, ei) => (
                <li key={ei} className="text-xs text-critical font-mono">{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Layer1Section({ report, expandedKeys, onToggle }: {
  report: Layer1Report; expandedKeys: Set<string>; onToggle: (key: string) => void;
}) {
  const passed = report.results.filter(r => r.schemaPassed).length;
  const failed = report.results.length - passed;

  return (
    <section id="protocol-validation" className="scroll-mt-16 print:break-before-page">
      <SectionHeader
        title="Layer 1 · Protocol Validation"
        badge={
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
            failed === 0
              ? 'bg-success/10 text-success border-success/30'
              : 'bg-critical/10 text-critical border-critical/30'
          }`}>
            {passed}/{report.results.length} passed
          </span>
        }
      />

      {report.noToolsCapability && (
        <div className="bg-surface border border-line border-l-4 border-l-warning rounded p-3 text-warning text-sm">
          This server does not advertise tool support.
        </div>
      )}

      <div className="space-y-2">
        {report.results.map((tool, i) => {
          const key = `l1:${tool.name}`;
          return (
            <Layer1ToolRow
              key={tool.name}
              tool={tool}
              index={i}
              total={report.results.length}
              expanded={expandedKeys.has(key)}
              onToggle={() => onToggle(key)}
            />
          );
        })}
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
    <div className="mt-2 bg-canvas border border-line rounded p-3 space-y-2.5">
      <div>
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">Problem</span>
        <p className="text-xs text-fg/85 leading-snug mt-0.5">{problemText(fix, clarity)}</p>
      </div>

      <div>
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">Why this matters</span>
        <p className="text-xs text-muted leading-snug mt-0.5">{whyThisMattersText(fix)}</p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className="text-[10px] font-semibold text-success uppercase tracking-wide">Recommended fix</span>
          <button
            onClick={copy}
            className="text-[10px] px-1.5 py-0.5 rounded border border-line text-muted
                       hover:text-fg hover:border-success/50 transition-colors font-mono print-hide"
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        <p className="text-xs text-fg/85 leading-snug">{fix.suggestedDescription}</p>
        {fix.scenarioContext && (
          <p className="text-[11px] text-muted leading-snug mt-1.5">
            Triggered by Scenario {fix.scenarioContext.scenarioIndex} — agent picked{' '}
            {fix.scenarioContext.pickedTool} instead of this tool.
          </p>
        )}
      </div>
    </div>
  );
}

// Collapsible tool card: Tool name → Score + status → (expanded) Problem → Why
// this matters → Recommended fix → Copy → Triggered scenario. Passed tools
// collapse by default so a clean report scans in seconds; anything flagged
// opens automatically so it can't be missed. Expand state is controlled by the
// parent so "Expand All" / "Collapse All" can drive every card at once.
function ToolCard({ result, fix, expanded, onToggle }: {
  result: ClarityResult; fix?: SuggestedFix; expanded: boolean; onToggle: () => void;
}) {
  const severity = claritySeverity(result.score);
  const accent = SEVERITY_ACCENT[severity ?? 'ok'];

  return (
    <div className={`border-l-4 ${accent} bg-surface border-y border-r border-line rounded overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-line/20 transition-colors"
      >
        <ScoreBadge score={result.score} />
        <span className="font-mono text-sm text-fg flex-1 min-w-0 truncate text-left">{result.name}</span>
        {severity ? <SeverityBadge severity={severity} /> : <PassBadge passed />}
        <span className="text-muted text-[10px] flex-shrink-0 select-none font-mono">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          {fix
            ? <SuggestedFixBox fix={fix} clarity={result} />
            : <p className="text-xs text-muted leading-snug border-t border-line pt-2">{result.verdict}</p>}
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
    <div className={`border-l-4 ${accent} bg-surface border-y border-r border-line rounded p-3`}>
      <div className="flex items-center gap-2 mb-1.5 text-sm font-mono flex-wrap">
        <span className={isHigh ? 'text-warning' : 'text-suggestion'}>{pair.tool1}</span>
        <span className="text-muted">↔</span>
        <span className={isHigh ? 'text-warning' : 'text-suggestion'}>{pair.tool2}</span>
        <SeverityBadge severity={severity} />
        {isHigh && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning
                           font-sans font-medium whitespace-nowrap border border-warning/30">
            confirmed by simulation
          </span>
        )}
      </div>
      <p className="text-xs text-muted leading-snug">{pair.reason}</p>
      {isHigh && pair.confirmedByScenario && (
        <p className="text-[11px] text-warning/90 leading-snug mt-1">
          Confirmed by Scenario {pair.confirmedByScenario} — agent picked {pair.confirmedByPickedTool} instead.
        </p>
      )}
    </div>
  );
}

function SimStatusTag({ sim }: { sim: SimulationResult }) {
  if (!sim.correct) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold
                       bg-critical/10 text-critical border border-critical/30">
        FAIL
      </span>
    );
  }
  if (sim.argWarning) {
    const suffix = sim.argIssueType === 'schema' ? 'schema' : 'args';
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold
                       bg-warning/10 text-warning border border-warning/30 whitespace-nowrap">
        WARN · {suffix}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold
                     bg-success/10 text-success border border-success/30">
      PASS
    </span>
  );
}

function SimulationRow({ sim, index }: { sim: SimulationResult; index: number }) {
  const severity = simulationSeverity(sim);
  const accent = SEVERITY_ACCENT[severity ?? 'ok'];
  return (
    <div className={`border-l-4 ${accent} bg-surface border-y border-r border-line rounded p-3`}>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted font-mono">SCENARIO {index + 1}</span>
          {severity && <SeverityBadge severity={severity} />}
        </div>
        <SimStatusTag sim={sim} />
      </div>
      <p className="text-xs text-fg/85 mb-2 leading-snug">&ldquo;{sim.request}&rdquo;</p>

      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs font-mono border-t border-line pt-2">
        <span className="text-muted">expected</span>
        <span className="text-fg">{sim.expectedTool}</span>
        <span className="text-muted">→</span>
        <span className="text-muted">picked</span>
        <span className={sim.correct ? 'text-success' : 'text-critical'}>{sim.pickedTool}</span>
      </div>

      {Object.keys(sim.pickedArgs).length > 0 && (
        <pre className="mt-1.5 text-[11px] text-muted bg-canvas border border-line px-2 py-1 rounded overflow-x-auto">
          {JSON.stringify(sim.pickedArgs)}
        </pre>
      )}
      {sim.argWarning && sim.argIssue && (
        <p className="text-xs text-warning/90 leading-snug mt-1.5">
          <span className="font-semibold uppercase tracking-wide text-[10px] text-warning/70 mr-1">
            {sim.argIssueType === 'schema' ? 'schema violation (programmatic):' : 'value quality warning (heuristic):'}
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
      <div className="bg-surface border border-line border-l-4 border-l-success rounded p-3 flex items-center gap-2">
        <span className="text-success text-sm leading-none">✓</span>
        <span className="text-success font-semibold text-sm">Server ready to ship</span>
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
    <div className={`bg-surface border border-line border-l-4 rounded p-3 ${
      notReady ? 'border-l-critical' : 'border-l-warning'
    }`}>
      <div className={`font-semibold text-sm mb-1 ${notReady ? 'text-critical' : 'text-warning'}`}>
        {headline}
      </div>
      <div className="text-xs text-muted font-mono">
        {summary.protocolPassed}/{summary.protocolTotal} protocol checks passed · {summary.compatibilityPassed}/{summary.compatibilityTotal} compatibility scenarios passed
        {' '}· {summary.improvementOpportunities} {opportunityWord} · {criticalText}
      </div>
    </div>
  );
}

// ─── Executive summary (top) & production verdict (bottom) ───────────────────

const PRODUCTION_STATUS_STYLE: Record<ReportSummary['productionStatus'], { emoji: string; label: string; cls: string }> = {
  ready:      { emoji: '✅', label: 'Ready for Production',            cls: 'text-success bg-success/10 border-success/30' },
  minor:      { emoji: '⚠',  label: 'Ready with Minor Improvements',   cls: 'text-warning bg-warning/10 border-warning/30' },
  'not-ready':{ emoji: '❌', label: 'Not Ready',                       cls: 'text-critical bg-critical/10 border-critical/30' },
};

function ProductionStatusBadge({ status }: { status: ReportSummary['productionStatus'] }) {
  const s = PRODUCTION_STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold border ${s.cls}`}>
      {s.emoji} {s.label}
    </span>
  );
}

// Anchor links to each report section — rendered as the second row of the
// sticky bar so it stays reachable while scrolling through a long report.
function SectionNav({ layer2Ran }: { layer2Ran: boolean }) {
  const links: Array<{ href: string; label: string }> = [
    { href: '#executive-summary', label: 'Executive Summary' },
    { href: '#protocol-validation', label: 'Protocol Validation' },
    ...(layer2Ran ? [
      { href: '#behavior-validation', label: 'Behavior Validation' },
      { href: '#compatibility-testing', label: 'Compatibility Testing' },
    ] : []),
    { href: '#final-verdict', label: 'Final Verdict' },
  ];
  return (
    <div className="border-t border-line print-hide">
      <div className="max-w-2xl mx-auto px-4 py-1 flex items-center gap-x-3 text-[10px] text-muted overflow-x-auto whitespace-nowrap">
        {links.map((l, i) => (
          <span key={l.href} className="flex items-center gap-x-3">
            {i > 0 && <span className="text-line">·</span>}
            <a href={l.href} className="hover:text-suggestion transition-colors">{l.label}</a>
          </span>
        ))}
      </div>
    </div>
  );
}

// Compact bar pinned to the top of the viewport once the page scrolls past the
// header — a VS Code status-bar: solid surface, tight padding, small text.
function StickySummaryBar({ summary, url, authHeader, onExport }: {
  summary: ReportSummary; url: string; authHeader: string; onExport: (format: ExportFormat) => void;
}) {
  const s = PRODUCTION_STATUS_STYLE[summary.productionStatus];
  const reanalyzeParams = new URLSearchParams({ url });
  if (authHeader) reanalyzeParams.set('auth', authHeader);
  return (
    <div className="sticky top-0 z-20 bg-surface border-b border-line print-hide">
      <div className="max-w-2xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-[11px] font-mono overflow-x-auto">
          <span className="font-bold text-fg whitespace-nowrap">
            {summary.healthScore}<span className="text-muted font-normal">/100</span>
          </span>
          <span className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap ${
            summary.productionStatus === 'ready' ? 'text-success' :
            summary.productionStatus === 'minor' ? 'text-warning' : 'text-critical'
          }`}>
            {s.emoji} {s.label}
          </span>
          <span className="text-critical whitespace-nowrap">🔴 {summary.criticalCount}</span>
          <span className="text-warning whitespace-nowrap">🟡 {summary.warningCount}</span>
          <span className="text-suggestion whitespace-nowrap">🔵 {summary.suggestionCount}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link href={`/?${reanalyzeParams.toString()}`}
            className="text-[11px] px-2 py-1 rounded border border-line text-muted
                       hover:text-fg hover:border-suggestion/50 transition-colors flex items-center gap-1 whitespace-nowrap">
            ← Re-analyze
          </Link>
          <ExportMenu onExport={onExport} />
        </div>
      </div>
      <SectionNav layer2Ran={summary.layer2Ran} />
    </div>
  );
}

function HealthScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 80 ? 'text-success border-success/30' :
    score >= 50 ? 'text-warning border-warning/30' :
                  'text-critical border-critical/30';
  return (
    <div className={`flex flex-col items-center justify-center w-16 h-16 rounded border flex-shrink-0 bg-canvas ${cls}`}>
      <span className="text-xl font-mono font-bold leading-none">{score}</span>
      <span className="text-[9px] uppercase tracking-wide mt-1 text-muted">health</span>
    </div>
  );
}

function StatRow({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const cls = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-critical' : 'text-fg';
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-xs font-mono font-semibold ${cls}`}>{value}</span>
    </div>
  );
}

// "████████░░" thin, square-edged bar — a filled track sized to the pass rate,
// so protocol/behavior/compatibility health reads at a glance, not just as a fraction.
function ProgressBar({ fraction, tone }: { fraction: number; tone: 'good' | 'bad' | 'neutral' }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const barCls = tone === 'good' ? 'bg-success' : tone === 'bad' ? 'bg-critical' : 'bg-warning';
  return (
    <div className="h-1 bg-line overflow-hidden">
      <div className={barCls} style={{ width: `${pct}%`, height: '100%' }} />
    </div>
  );
}

function StatBarRow({ label, value, fraction, tone }: { label: string; value: string; fraction: number; tone: 'good' | 'bad' | 'neutral' }) {
  const cls = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-critical' : 'text-fg';
  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs text-muted">{label}</span>
        <span className={`text-xs font-mono font-semibold ${cls}`}>{value}</span>
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
    <section id="executive-summary" className="scroll-mt-16 bg-surface border border-line rounded p-3">
      <div className="flex items-start gap-2.5 mb-3">
        <HealthScoreBadge score={summary.healthScore} />
        <div className="flex-1 min-w-0">
          <h2 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1.5">Executive Summary</h2>
          <ProductionStatusBadge status={summary.productionStatus} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4">
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
        <div className="mt-2 pt-2 border-t border-line space-y-1">
          {summary.highlights.map(h => (
            <div key={h} className="text-xs text-success flex items-center gap-1.5">
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

  // Nothing at all was flagged — not even a suggestion — and the full check
  // suite actually ran. Say so plainly instead of a report that just trails
  // off into checkmarks with no closing statement.
  const isPerfect = summary.layer2Ran &&
    summary.criticalCount === 0 && summary.warningCount === 0 && summary.suggestionCount === 0;
  if (isPerfect) {
    return ['✓ Excellent MCP implementation — No issues detected. Ready for production.'];
  }

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
  const accentCls =
    summary.productionStatus === 'ready' ? 'border-l-success' :
    summary.productionStatus === 'minor' ? 'border-l-warning' : 'border-l-critical';
  const lines = verdictExplanation(summary);

  return (
    <section id="final-verdict" className={`scroll-mt-16 bg-surface border border-line border-l-4 ${accentCls} rounded p-4 print:break-before-page`}>
      <div className="flex items-center gap-2 text-sm font-bold mb-3">
        <span>{s.emoji}</span><span className="text-fg">{s.label}</span>
      </div>
      <div className="space-y-1.5 text-sm text-muted leading-snug">
        {lines.map((line, i) => <p key={i}>{line}</p>)}
      </div>
    </section>
  );
}

function Layer2Section({ report, summary, expandedKeys, onToggle }: {
  report: Layer2Report; summary: ReportSummary; expandedKeys: Set<string>; onToggle: (key: string) => void;
}) {
  const simTotal = report.simulation.length;
  const simPassed = report.simulationScore;
  const fixByName = new Map(report.suggestedFixes.map(f => [f.name, f]));
  const showConfusionCaveat = report.confusedPairs.length > 0 && simTotal > 0 && simPassed === simTotal;

  return (
    <section id="behavior-validation" className="scroll-mt-16 space-y-6 print:break-before-page">
      <VerdictBanner summary={summary} />

      <SectionHeader title="Layer 2 · Behavior Validation" />

      {/* Check 1: Clarity */}
      <div>
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
          Check 1 · Clarity Analysis
        </h3>
        <div className="space-y-2">
          {report.clarity.map(r => {
            const key = `l2:${r.name}`;
            return (
              <ToolCard
                key={r.name}
                result={r}
                fix={fixByName.get(r.name)}
                expanded={expandedKeys.has(key)}
                onToggle={() => onToggle(key)}
              />
            );
          })}
        </div>
      </div>

      {/* Check 2: Confusion */}
      <div>
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
          Check 2 · Ambiguity Analysis
        </h3>
        {report.confusedPairs.length === 0 ? (
          <div className="bg-surface border border-line border-l-4 border-l-success rounded p-3 text-success text-sm">
            ✓ No confused tool pairs detected.
          </div>
        ) : (
          <div className="space-y-2">
            {report.confusedPairs.map((pair, i) => <ConfusionRow key={i} pair={pair} />)}
          </div>
        )}
      </div>

      {/* Check 3: Simulation */}
      <div id="compatibility-testing" className="scroll-mt-16 print:break-before-page">
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2 flex items-center gap-3">
          Check 3 · Compatibility Testing
          <span className={`normal-case text-xs font-mono font-bold ${
            simPassed === simTotal ? 'text-success' :
            simPassed >= Math.ceil(simTotal / 2) ? 'text-warning' :
            'text-critical'
          }`}>
            {simPassed}/{simTotal} passed
          </span>
        </h3>
        <p className="text-[11px] text-muted mb-2 normal-case">
          Agent simulation run at fixed temperature for reproducible results.
        </p>
        {showConfusionCaveat && (
          <p className="text-[11px] text-muted leading-snug mb-2 normal-case">
            {simPassed}/{simTotal} passed on this run — confusion risk flagged above may surface on
            different user phrasings. Scenario simulation is one sample; confusion detection identifies
            structural risk regardless of this run&rsquo;s outcome.
          </p>
        )}
        <div className="space-y-2">
          {report.simulation.map((sim, i) => <SimulationRow key={i} sim={sim} index={i} />)}
        </div>
      </div>
    </section>
  );
}

// ─── Export ─────────────────────────────────────────────────────────────────

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function exportFilenameBase(hostname: string): string {
  const safeHost = hostname.replace(/[^a-z0-9.-]/gi, '-');
  const date = new Date().toISOString().slice(0, 10);
  return `mcp-checker-${safeHost}-${date}`;
}

function buildMarkdownReport(
  layer1: Layer1Report, layer2: Layer2Report | null, summary: ReportSummary, hostname: string,
): string {
  const serverName = layer1.serverName ?? hostname;
  const lines: string[] = [];

  lines.push(`# MCP Checker Report — ${serverName}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push(`Health Score: ${summary.healthScore}/100`);
  lines.push(`Production Status: ${PRODUCTION_STATUS_STYLE[summary.productionStatus].label}`);
  lines.push(`Protocol Validation: ${summary.protocolPassed}/${summary.protocolTotal} Passed`);
  lines.push(`Behavior Validation: ${summary.behaviorLabel}`);
  lines.push(`Compatibility Testing: ${summary.layer2Ran ? `${summary.compatibilityPassed}/${summary.compatibilityTotal} Passed` : 'Not run'}`);
  lines.push(`Critical Issues: ${summary.criticalCount} | Warnings: ${summary.warningCount} | Suggestions: ${summary.suggestionCount}`);
  lines.push('');

  lines.push('## Protocol Validation');
  layer1.results.forEach(r => {
    lines.push(`- \`${r.name}\`: ${r.schemaPassed ? 'PASSED' : 'FAILED'}`);
    if (!r.schemaPassed && r.schemaErrors?.length) {
      r.schemaErrors.forEach(err => lines.push(`  - ${err}`));
    }
  });
  lines.push('');

  if (layer2) {
    const fixByName = new Map(layer2.suggestedFixes.map(f => [f.name, f]));

    lines.push('## Behavior Validation');
    lines.push('');
    lines.push('### Clarity Analysis');
    layer2.clarity.forEach(c => {
      const severity = claritySeverity(c.score);
      lines.push(`- \`${c.name}\` — score ${Math.round(c.score)}/10${severity ? ` (${SEVERITY_STYLE[severity].label})` : ''}`);
      lines.push(`  ${c.verdict}`);
      const fix = fixByName.get(c.name);
      if (fix) {
        lines.push(`  - **Problem:** ${problemText(fix, c)}`);
        lines.push(`  - **Why This Matters:** ${whyThisMattersText(fix)}`);
        lines.push('  - **Recommended Fix:**');
        lines.push('    ```');
        lines.push(`    ${fix.suggestedDescription}`);
        lines.push('    ```');
      }
    });
    lines.push('');

    lines.push('### Ambiguity Analysis');
    if (layer2.confusedPairs.length === 0) {
      lines.push('No confused tool pairs detected.');
    } else {
      layer2.confusedPairs.forEach(pair => {
        const severity = confusionSeverity(pair);
        lines.push(`- \`${pair.tool1}\` ↔ \`${pair.tool2}\` — ${SEVERITY_STYLE[severity].label}`);
        lines.push(`  ${pair.reason}`);
        if (pair.confirmedByScenario) {
          lines.push(`  Confirmed by Scenario ${pair.confirmedByScenario} — agent picked ${pair.confirmedByPickedTool} instead.`);
        }
      });
    }
    lines.push('');

    lines.push('## Compatibility Testing');
    layer2.simulation.forEach((sim, i) => {
      const status = !sim.correct ? 'FAIL' : sim.argWarning ? 'WARN' : 'PASS';
      lines.push(`### Scenario ${i + 1} — ${status}`);
      lines.push(`- User request: "${sim.request}"`);
      lines.push(`- Expected tool: \`${sim.expectedTool}\``);
      lines.push(`- Picked tool: \`${sim.pickedTool}\``);
      if (sim.argWarning && sim.argIssue) {
        lines.push(`- ${sim.argIssueType === 'schema' ? 'Schema violation' : 'Value quality warning'}: ${sim.argIssue}`);
      }
      lines.push('');
    });
  }

  lines.push('## Production Verdict');
  lines.push(PRODUCTION_STATUS_STYLE[summary.productionStatus].label);
  lines.push('');
  verdictExplanation(summary).forEach(line => lines.push(line));

  return lines.join('\n');
}

function buildJsonReport(
  layer1: Layer1Report, layer2: Layer2Report | null, summary: ReportSummary, hostname: string,
) {
  return {
    healthScore: summary.healthScore,
    productionStatus: summary.productionStatus,
    serverName: layer1.serverName ?? hostname,
    serverVersion: layer1.serverVersion ?? null,
    toolCount: layer1.toolCount,
    generatedAt: new Date().toISOString(),
    protocol: {
      tools: layer1.results.map(r => ({
        name: r.name,
        passed: r.schemaPassed,
        schema: r.schemaErrors ?? [],
      })),
    },
    behavior: layer2 ? {
      clarity: layer2.clarity,
      ambiguityPairs: layer2.confusedPairs,
      suggestedFixes: layer2.suggestedFixes,
    } : null,
    compatibility: layer2 ? {
      scenarios: layer2.simulation.map(sim => ({
        request: sim.request,
        expected: sim.expectedTool,
        picked: sim.pickedTool,
        passed: sim.correct,
        violation: sim.argWarning ? (sim.argIssue ?? null) : null,
      })),
    } : null,
    verdict: {
      status: summary.productionStatus,
      explanation: verdictExplanation(summary).join(' '),
    },
  };
}

type ExportFormat = 'md' | 'pdf' | 'json';

function ExportMenu({ onExport }: { onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = (format: ExportFormat) => {
    setOpen(false);
    onExport(format);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[11px] px-2 py-1 rounded border border-line text-muted
                   hover:text-fg hover:border-suggestion/50 transition-colors font-mono flex items-center gap-1"
      >
        Export <span className="text-[8px]">▼</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-48 bg-surface border border-line rounded shadow-lg z-30 overflow-hidden">
          <button
            onClick={() => select('md')}
            className="w-full text-left px-3 py-1.5 text-xs text-fg/85 hover:bg-line/30 transition-colors font-mono"
          >
            Export as Markdown (.md)
          </button>
          <button
            onClick={() => select('pdf')}
            className="w-full text-left px-3 py-1.5 text-xs text-fg/85 hover:bg-line/30 transition-colors font-mono border-t border-line"
          >
            Export as PDF (.pdf)
          </button>
          <button
            onClick={() => select('json')}
            className="w-full text-left px-3 py-1.5 text-xs text-fg/85 hover:bg-line/30 transition-colors font-mono border-t border-line"
          >
            Export as JSON (.json)
          </button>
        </div>
      )}
    </div>
  );
}

function ExportToast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 print-hide bg-surface border border-success/30
                     text-success text-xs px-3 py-2 rounded shadow-lg">
      {message}
    </div>
  );
}

// Rendered only in print output — the on-screen header carries the same info
// via the sticky bar / nav, both of which are hidden on paper.
function PrintHeader({ serverName }: { serverName: string }) {
  return (
    <div className="hidden print:block mb-4 pb-2 border-b border-line">
      <h1 className="text-lg font-bold text-fg">MCP Checker Report — {serverName}</h1>
      <p className="text-sm text-muted">{new Date().toLocaleString()}</p>
    </div>
  );
}

// ─── Main results content ─────────────────────────────────────────────────────

function ResultsContent() {
  const params = useSearchParams();
  const router = useRouter();

  const url  = params.get('url') ?? '';
  const runAi = params.get('ai') === 'true';
  const authHeader = params.get('auth') ?? '';

  const [layer1, setLayer1]             = useState<Layer1Report | null>(null);
  const [layer1Loading, setLayer1Loading] = useState(true);
  const [layer1Error, setLayer1Error]   = useState<string | null>(null);

  const [layer2, setLayer2]             = useState<Layer2Report | null>(null);
  const [layer2Loading, setLayer2Loading] = useState(false);
  const [layer2Error, setLayer2Error]   = useState<string | null>(null);

  // Which tool cards are expanded, keyed "l1:<name>" / "l2:<name>" so Layer 1
  // and Layer 2 rows for the same tool name don't collide. Centralized here
  // (rather than local state per card) so Expand All / Collapse All can drive
  // every card at once.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleKey = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Seed default-expanded cards (failed schemas, warning-level clarity) the
  // moment each dataset arrives, without clobbering any manual toggles made since.
  useEffect(() => {
    if (!layer1) return;
    setExpandedKeys(prev => {
      const next = new Set(prev);
      layer1.results.forEach(r => { if (!r.schemaPassed) next.add(`l1:${r.name}`); });
      return next;
    });
  }, [layer1]);

  useEffect(() => {
    if (!layer2) return;
    setExpandedKeys(prev => {
      const next = new Set(prev);
      layer2.clarity.forEach(c => { if (claritySeverity(c.score) === 'warning') next.add(`l2:${c.name}`); });
      return next;
    });
  }, [layer2]);

  const allCardKeys = (): string[] => {
    const keys: string[] = [];
    if (layer1) layer1.results.forEach(r => keys.push(`l1:${r.name}`));
    if (layer2) layer2.clarity.forEach(c => keys.push(`l2:${c.name}`));
    return keys;
  };
  const expandAll = () => setExpandedKeys(new Set(allCardKeys()));
  const collapseAll = () => setExpandedKeys(new Set());

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Sequential loading messages. The real network calls are just two fetches
  // (Layer 1, then Layer 2), so each phase's second message is a timed
  // progression rather than a distinct backend event — the interval is
  // cleared the moment the fetch actually resolves either way.
  const [layer1Tick, setLayer1Tick] = useState(0);
  useEffect(() => {
    setLayer1Tick(0);
    if (!layer1Loading) return;
    const id = setInterval(() => setLayer1Tick(t => Math.min(t + 1, 1)), 900);
    return () => clearInterval(id);
  }, [layer1Loading]);

  const [layer2Tick, setLayer2Tick] = useState(0);
  useEffect(() => {
    setLayer2Tick(0);
    if (!layer2Loading) return;
    const id = setInterval(() => setLayer2Tick(t => Math.min(t + 1, 1)), 1200);
    return () => clearInterval(id);
  }, [layer2Loading]);

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
      body:    JSON.stringify(authHeader ? { url, authHeader } : { url }),
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
  const dataReady = layer1 !== null && !layer1Loading && (!runAi || layer2 !== null || layer2Error !== null);

  // Brief "Generating report..." beat between the last fetch resolving and the
  // report appearing — the fifth loading step, not a real async gap.
  const [finalizing, setFinalizing] = useState(false);
  useEffect(() => {
    if (!dataReady) return;
    setFinalizing(true);
    const t = setTimeout(() => setFinalizing(false), 350);
    return () => clearTimeout(t);
  }, [dataReady]);

  const summary = dataReady && !finalizing && layer1 ? computeReportSummary(layer1, layer2) : null;

  const handleExport = (format: ExportFormat) => {
    if (!layer1 || !summary) return;
    if (format === 'md') {
      const content = buildMarkdownReport(layer1, layer2, summary, hostname);
      downloadTextFile(`${exportFilenameBase(hostname)}.md`, content, 'text/markdown');
      setToast('✓ Markdown exported successfully.');
    } else if (format === 'json') {
      const content = JSON.stringify(buildJsonReport(layer1, layer2, summary, hostname), null, 2);
      downloadTextFile(`${exportFilenameBase(hostname)}.json`, content, 'application/json');
      setToast('✓ JSON exported successfully.');
    } else {
      expandAll();
      setToast("✓ Use your browser's Save as PDF option.");
      setTimeout(() => window.print(), 100);
    }
  };

  const currentStepLabel: string | null =
    layer1Loading ? (layer1Tick === 0 ? 'Connecting to MCP server...' : 'Validating protocol...') :
    layer2Loading ? (layer2Tick === 0 ? 'Running behavior analysis...' : 'Running compatibility simulations...') :
    (dataReady && finalizing) ? 'Generating report...' :
    null;

  return (
    <div className="min-h-screen bg-canvas">
      {/* Top bar */}
      <header className="border-b border-line px-4 py-2.5 flex items-center gap-3 print-hide">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] text-muted">Checking</span>
          <span className="font-mono text-xs text-suggestion truncate">{hostname}</span>
        </div>
      </header>

      {summary && <StickySummaryBar summary={summary} url={url} authHeader={authHeader} onExport={handleExport} />}

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {summary && <PrintHeader serverName={layer1?.serverName ?? hostname} />}
        {/* Executive summary dashboard — leads the whole report */}
        {summary && <ExecutiveSummary summary={summary} />}
        {!summary && dataReady && finalizing && (
          <div className="bg-surface border border-line rounded p-3">
            <Spinner label={currentStepLabel ?? 'Generating report...'} />
          </div>
        )}

        {/* Server info + Layer 1 are grouped tightly — the info line is Layer 1's intro, not its own section */}
        <div className="space-y-3">
          {layer1 && !layer1Loading && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 bg-success rounded-full flex-shrink-0" />
                {layer1.serverName ? (
                  <span className="text-fg/80 truncate">
                    <span className="font-semibold text-fg">{layer1.serverName}</span>
                    {layer1.serverVersion && <span className="text-muted"> v{layer1.serverVersion}</span>}
                    <span className="text-muted"> · {layer1.toolCount} tool{layer1.toolCount !== 1 ? 's' : ''}</span>
                  </span>
                ) : (
                  <span className="text-muted">{layer1.toolCount} tool{layer1.toolCount !== 1 ? 's' : ''} found</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0 print-hide">
                <button
                  onClick={expandAll}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-line text-muted
                             hover:text-fg hover:border-suggestion/50 transition-colors font-mono"
                >
                  expand all
                </button>
                <button
                  onClick={collapseAll}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-line text-muted
                             hover:text-fg hover:border-suggestion/50 transition-colors font-mono"
                >
                  collapse all
                </button>
              </div>
            </div>
          )}

          {layer1Loading && (
            <div className="bg-surface border border-line rounded p-3">
              <Spinner label={currentStepLabel ?? 'Connecting to MCP server...'} />
            </div>
          )}
          {layer1Error && !layer1 && !layer1Loading && (
            <ErrorBox message={layer1Error} defaultHeader="Connection failed" />
          )}
          {layer1 && !layer1Loading && (
            <Layer1Section report={layer1} expandedKeys={expandedKeys} onToggle={toggleKey} />
          )}
        </div>

        {/* Layer 2 */}
        {layer2Loading && (
          <div className="bg-surface border border-line rounded p-3">
            <Spinner label={currentStepLabel ?? 'Running behavior analysis...'} />
          </div>
        )}
        {layer2Error && (
          <ErrorBox message={layer2Error} defaultHeader="Layer 2 failed" />
        )}
        {layer2 && summary && (
          <Layer2Section report={layer2} summary={summary} expandedKeys={expandedKeys} onToggle={toggleKey} />
        )}

        {/* Production verdict — closes out the report */}
        {summary && <ProductionVerdict summary={summary} />}

        {/* Check another */}
        {!layer1Loading && (
          <div className="pt-3 border-t border-line print-hide">
            <Link href="/"
              className="text-xs text-muted hover:text-fg transition-colors">
              ← Check another server
            </Link>
          </div>
        )}
      </main>

      {toast && <ExportToast message={toast} />}
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    }>
      <ResultsContent />
    </Suspense>
  );
}
