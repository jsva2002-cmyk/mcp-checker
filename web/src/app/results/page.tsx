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
// Kept in sync with DAILY_CAP_MESSAGE in web/src/lib/dailyAiCap.ts — the backend
// returns this exact string when the global daily AI-check cap is reached.
const DAILY_CAP_MESSAGE =
  "AI-powered checks have reached today's capacity — protocol validation is still available. Please try again tomorrow, or check back later.";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function friendlyErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) return RATE_LIMIT_MESSAGE;
  if (e instanceof ApiError && e.status === 503 && e.message === DAILY_CAP_MESSAGE) return DAILY_CAP_MESSAGE;
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

// Warning/Critical always get the full-weight 4px colored stripe so they read
// instantly across every card type. Suggestion is intentionally lighter-weight
// (thin, uncolored) so it doesn't compete visually with things that need
// attention — it's a lower tier, not a broken/missing card.
function cardAccentClass(severity: Severity | null): string {
  if (severity === 'critical') return `border-l-4 ${SEVERITY_ACCENT.critical}`;
  if (severity === 'warning') return `border-l-4 ${SEVERITY_ACCENT.warning}`;
  if (severity === 'suggestion') return 'border-l border-line';
  return `border-l-4 ${SEVERITY_ACCENT.ok}`;
}

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
// Single source of truth for the executive summary, the tab badges, and the
// production verdict — all three read from this so the numbers never drift.

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
  productionStatus: 'ready' | 'minor' | 'not-ready' | 'incomplete';
  highlights: string[];
  layer2Ran: boolean;
  // True when Layer 2/3 didn't run because the global daily AI-check cap was
  // reached — distinct from layer2Ran===false due to a real failure or AI not
  // being requested at all, since here the score/verdict must not be presented
  // as if Behavior/Compatibility ran and passed.
  capacityLimited: boolean;
}

function computeReportSummary(
  layer1: Layer1Report, layer2: Layer2Report | null, capacityLimited = false,
): ReportSummary {
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
    capacityLimited ? 'incomplete' :
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
    capacityLimited,
  };
}

// 3-4 sentence explanation of exactly why the production verdict landed where it
// did — built from the same counts shown above it, not a separate judgment call.
function verdictExplanation(summary: ReportSummary): string[] {
  const lines: string[] = [];

  const isPerfect = summary.layer2Ran &&
    summary.criticalCount === 0 && summary.warningCount === 0 && summary.suggestionCount === 0;
  if (isPerfect) {
    return ['Excellent MCP implementation — no issues detected. Ready for production.'];
  }

  if (summary.capacityLimited) {
    return [
      `Protocol validation completed: ${summary.protocolPassed}/${summary.protocolTotal} check${summary.protocolTotal === 1 ? '' : 's'} passed.`,
      "AI-powered behavior and compatibility checks did not run because today's capacity limit was reached — this is an incomplete verdict, not a pass or fail.",
      'Check back tomorrow once the daily limit resets for a full verdict.',
    ];
  }

  if (summary.productionStatus === 'ready') {
    const protocolClause = `All ${summary.protocolTotal} protocol check${summary.protocolTotal === 1 ? '' : 's'} passed`;
    const compatClause = !summary.layer2Ran
      ? 'compatibility testing was not run'
      : summary.compatibilityTotal === 0
      ? 'no compatibility scenarios were generated'
      : `the agent picked the correct tool in ${summary.compatibilityPassed}/${summary.compatibilityTotal} compatibility scenarios`;
    lines.push(`${protocolClause}, and ${compatClause}.`);
    if (summary.clarityAverage !== null) {
      lines.push(`Clarity scores average ${summary.clarityAverage.toFixed(1)}/10 with no confirmed ambiguous tool pairs.`);
    }
    lines.push('No critical issues or warnings were found in this run — this server is safe to ship as-is.');
    return lines;
  }

  if (summary.productionStatus === 'minor') {
    const compatClause = summary.compatibilityTotal === 0
      ? 'no compatibility scenarios were generated'
      : `${summary.compatibilityPassed}/${summary.compatibilityTotal} compatibility scenarios correct`;
    lines.push(
      `Protocol validation and tool selection are solid: ${summary.protocolPassed}/${summary.protocolTotal} schemas valid, ${compatClause}.`,
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
  const notReadyCompatClause = !summary.layer2Ran
    ? 'compatibility testing was not run'
    : summary.compatibilityTotal === 0
    ? 'no compatibility scenarios were generated'
    : `${summary.compatibilityPassed}/${summary.compatibilityTotal} compatibility scenarios were handled correctly`;
  lines.push(
    `${summary.protocolPassed}/${summary.protocolTotal} protocol checks passed and ${notReadyCompatClause}.`,
  );
  if (summary.warningCount > 0) {
    lines.push(`${summary.warningCount} additional warning${summary.warningCount === 1 ? '' : 's'} should be fixed once the critical issues are resolved.`);
  }
  lines.push('Fix the critical issues above before shipping this server.');
  return lines;
}

function execSummaryLine(summary: ReportSummary): string {
  if (summary.capacityLimited) {
    return `Protocol validation: ${summary.protocolPassed}/${summary.protocolTotal} checks passed. AI-powered checks did not run — today's capacity limit was reached.`;
  }
  if (summary.criticalCount === 0 && summary.warningCount === 0 && summary.suggestionCount === 0) {
    return 'All protocol validation checks passed with no issues detected.';
  }
  if (summary.criticalCount > 0) {
    return `${summary.criticalCount} critical issue${summary.criticalCount === 1 ? '' : 's'} need${summary.criticalCount === 1 ? 's' : ''} to be fixed before this server is production-ready.`;
  }
  if (summary.warningCount > 0) {
    return `No critical issues — ${summary.warningCount} warning${summary.warningCount === 1 ? '' : 's'} worth addressing before scaling usage.`;
  }
  return `${summary.suggestionCount} minor suggestion${summary.suggestionCount === 1 ? '' : 's'} for improvement — nothing blocking.`;
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

// ─── Shared building blocks ─────────────────────────────────────────────────

// Shown in place of Behavior/Compatibility content whenever the global daily
// AI-check cap has been hit — a capacity notice, not a failure, so it always
// renders with the neutral/info tone rather than the critical/error styling
// used for real Layer 2 failures.
const AI_CAPACITY_MESSAGE =
  "AI-powered checks (Behavior & Compatibility) have reached today's capacity due to high traffic. Protocol validation above is still accurate. Please check back tomorrow.";

function AiCapacityBanner() {
  return (
    <div className="border border-suggestion/30 bg-suggestion/5 rounded p-3 h-full flex items-center gap-2.5">
      <span className="text-suggestion text-base flex-shrink-0" aria-hidden>ℹ</span>
      <p className="text-xs text-fg/80 leading-snug">{AI_CAPACITY_MESSAGE}</p>
    </div>
  );
}

function Callout({ tone, title, children }: { tone: 'info' | 'warning' | 'success'; title?: string; children: React.ReactNode }) {
  const cls =
    tone === 'info' ? 'border-suggestion/30 bg-suggestion/5' :
    tone === 'warning' ? 'border-warning/30 bg-warning/5' :
    'border-success/30 bg-success/5';
  const titleCls = tone === 'info' ? 'text-suggestion' : tone === 'warning' ? 'text-warning' : 'text-success';
  return (
    <div className={`border rounded p-3 ${cls}`}>
      {title && <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${titleCls}`}>{title}</div>}
      <p className="text-xs text-fg/80 leading-snug">{children}</p>
    </div>
  );
}

function CountBadge({ label, count, tone }: { label: string; count: number; tone: 'critical' | 'warning' | 'suggestion' }) {
  const cls =
    tone === 'critical' ? 'text-critical border-critical/30 bg-critical/5' :
    tone === 'warning' ? 'text-warning border-warning/30 bg-warning/5' :
    'text-suggestion border-suggestion/30 bg-suggestion/5';
  return (
    <div className={`border rounded p-2.5 text-center ${cls}`}>
      <div className="text-lg font-mono font-bold leading-none">{count}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted mt-1">{label}</div>
    </div>
  );
}

function HealthGauge({ score, status }: { score: number; status: ReportSummary['productionStatus'] }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const incomplete = status === 'incomplete';
  const pct = Math.max(0, Math.min(100, score));
  // An incomplete verdict has no meaningful score to plot — an empty ring
  // avoids implying a real percentage was computed.
  const offset = incomplete ? circumference : circumference * (1 - pct / 100);
  // Color must always agree with the production status badge next to it — a
  // high score with a critical issue (e.g. one failed schema) is still Not
  // Ready, so the gauge reads red even though the number itself is high.
  const colorCls =
    status === 'ready' ? 'text-success' :
    status === 'minor' ? 'text-warning' :
    status === 'incomplete' ? 'text-suggestion' : 'text-critical';
  return (
    <div className="relative w-24 h-24 flex-shrink-0">
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeWidth="8" className="text-line" />
        <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} className={colorCls} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-mono font-bold text-fg leading-none">{incomplete ? '—' : score}</span>
        <span className="text-[9px] uppercase tracking-wide mt-1 text-muted">{incomplete ? 'N/A' : '/ 100'}</span>
      </div>
    </div>
  );
}

function LayerStatCard({ label, value, fraction, tone, split }: {
  label: string; value: string; fraction: number; tone: 'good' | 'bad' | 'neutral'; split?: boolean;
}) {
  const valueCls = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-critical' : 'text-fg';
  const barCls = tone === 'good' ? 'bg-success' : tone === 'bad' ? 'bg-critical' : 'bg-warning';
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="bg-surface border border-line rounded p-3">
      <div className="text-[10px] text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-xs font-mono font-semibold ${valueCls}`}>{value}</div>
      {split ? (
        // Pass/fail ratio, not a quality score — show the failed portion in
        // red rather than implying quality via a single graded tone.
        <div className="h-1 bg-line mt-2 overflow-hidden flex">
          <div className="bg-success h-full" style={{ width: `${pct}%` }} />
          <div className="bg-critical h-full" style={{ width: `${100 - pct}%` }} />
        </div>
      ) : (
        <div className="h-1 bg-line mt-2 overflow-hidden">
          <div className={barCls} style={{ width: `${pct}%`, height: '100%' }} />
        </div>
      )}
    </div>
  );
}

const PRODUCTION_STATUS_STYLE: Record<ReportSummary['productionStatus'], { emoji: string; label: string; cls: string }> = {
  ready:      { emoji: '✅', label: 'Ready for Production',            cls: 'text-success bg-success/10 border-success/30' },
  minor:      { emoji: '⚠',  label: 'Ready with Minor Improvements',   cls: 'text-warning bg-warning/10 border-warning/30' },
  'not-ready':{ emoji: '❌', label: 'Not Ready',                       cls: 'text-critical bg-critical/10 border-critical/30' },
  incomplete: { emoji: 'ℹ',  label: 'Verdict Unavailable',             cls: 'text-suggestion bg-suggestion/10 border-suggestion/30' },
};

function ProductionStatusBadge({ status }: { status: ReportSummary['productionStatus'] }) {
  const s = PRODUCTION_STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold border ${s.cls}`}>
      {s.emoji} {s.label}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center bg-surface border border-line rounded">
      <span className="w-9 h-9 rounded-full bg-success/10 border border-success/30 text-success flex items-center justify-center text-base">✓</span>
      <p className="text-sm text-fg/85">{message}</p>
    </div>
  );
}

function LayerSectionHeader({ title, passed, total, description, allExpanded, onToggleAll }: {
  title: string; passed: number; total: number; description: string; allExpanded: boolean; onToggleAll: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
          total > 0 && passed === total
            ? 'bg-success/10 text-success border-success/30'
            : 'bg-critical/10 text-critical border-critical/30'
        }`}>
          {passed}/{total} Passed
        </span>
        <div className="flex-1" />
        {total > 0 && (
          <button
            type="button"
            onClick={onToggleAll}
            className="text-[10px] px-1.5 py-0.5 rounded border border-line text-muted
                       hover:text-fg hover:border-suggestion/50 transition-colors font-mono print-hide"
          >
            {allExpanded ? 'Collapse All' : 'Expand All'}
          </button>
        )}
      </div>
      <p className="text-xs text-muted leading-snug">{description}</p>
    </div>
  );
}

// Animates a card's expand/collapse smoothly without measuring content height
// in JS: a 0fr↔1fr grid row transition clips/reveals the content naturally
// regardless of how tall it is. `min-h-0` on the inner wrapper is required —
// grid items default to their content's min-content height otherwise, which
// would prevent the row from ever fully collapsing to 0.
function CollapsiblePanel({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
      <div className="overflow-hidden min-h-0">
        {children}
      </div>
    </div>
  );
}

// ─── Layer 1 · Protocol card ──────────────────────────────────────────────────

function Layer1ToolRow({ tool, index, total, expanded, onToggle }: {
  tool: ToolSchemaResult; index: number; total: number; expanded: boolean; onToggle: () => void;
}) {
  const severity = schemaSeverity(tool.schemaPassed);
  const accentCls = cardAccentClass(severity);

  return (
    <div className={`${accentCls} bg-surface border-y border-r border-line rounded overflow-hidden`}>
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

      <CollapsiblePanel expanded={expanded}>
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
      </CollapsiblePanel>
    </div>
  );
}

// ─── Layer 2 · Behavior card ──────────────────────────────────────────────────

function problemText(fix: SuggestedFix, clarity?: ClarityResult): string {
  if (fix.reasons.includes('clarity') && clarity) return clarity.verdict;
  if (fix.scenarioContext) {
    return `Agent picked ${fix.scenarioContext.pickedTool} instead of this tool for a matching request.`;
  }
  return clarity?.verdict ?? 'Description needs clarification for reliable tool selection.';
}

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

// Suggestion-tier clarity results never get a generated fix (the backend only
// generates one below CLARITY_FIX_THRESHOLD) — so this gives them the same
// Problem / Why This Matters shape as a real fix card, just lighter-weight,
// rather than a bare unlabeled paragraph that reads as a broken card.
function SuggestionBox({ verdict }: { verdict: string }) {
  return (
    <div className="mt-2 bg-canvas border border-line rounded p-3 space-y-2.5">
      <div>
        <span className="text-[10px] font-medium text-muted/70 uppercase tracking-wide">Problem</span>
        <p className="text-xs text-muted leading-snug mt-0.5">{verdict}</p>
      </div>
      <div>
        <span className="text-[9px] font-medium text-muted/50 uppercase tracking-wide">Why this matters</span>
        <p className="text-[11px] text-muted/70 leading-snug mt-0.5">
          Borderline clarity — usually fine, but slightly more specific wording would remove any doubt for an agent choosing between similar tools.
        </p>
      </div>
    </div>
  );
}

function ToolCard({ result, fix, expanded, onToggle }: {
  result: ClarityResult; fix?: SuggestedFix; expanded: boolean; onToggle: () => void;
}) {
  const severity = claritySeverity(result.score);
  const accentCls = cardAccentClass(severity);

  return (
    <div className={`${accentCls} bg-surface border-y border-r border-line rounded overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-line/20 transition-colors"
      >
        <ScoreBadge score={result.score} />
        <span className="font-mono text-sm text-fg flex-1 min-w-0 break-words text-left">{result.name}</span>
        {severity ? <SeverityBadge severity={severity} /> : <PassBadge passed />}
        <span className="text-muted text-[10px] flex-shrink-0 select-none font-mono">{expanded ? '−' : '+'}</span>
      </button>

      <CollapsiblePanel expanded={expanded}>
        <div className="px-3 pb-3">
          {fix ? (
            <SuggestedFixBox fix={fix} clarity={result} />
          ) : severity === 'suggestion' ? (
            <SuggestionBox verdict={result.verdict} />
          ) : (
            <p className="text-xs text-muted leading-snug border-t border-line pt-2">{result.verdict}</p>
          )}
        </div>
      </CollapsiblePanel>
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

// ─── Layer 3 · Compatibility card ─────────────────────────────────────────────

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

function SimulationRow({ sim, index, fix, expanded, onToggle }: {
  sim: SimulationResult; index: number; fix?: SuggestedFix; expanded: boolean; onToggle: () => void;
}) {
  const severity = simulationSeverity(sim);
  const accentCls = cardAccentClass(severity);
  return (
    <div className={`${accentCls} bg-surface border-y border-r border-line rounded overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-line/20 transition-colors"
      >
        <span className="text-[10px] text-muted font-mono flex-shrink-0 mt-0.5">#{index + 1}</span>
        <span className="text-xs text-fg/85 flex-1 min-w-0 break-words text-left">&ldquo;{sim.request}&rdquo;</span>
        <SimStatusTag sim={sim} />
        <span className="text-muted text-[10px] flex-shrink-0 select-none font-mono">{expanded ? '−' : '+'}</span>
      </button>

      <CollapsiblePanel expanded={expanded}>
        <div className="px-3 pb-3 border-t border-line pt-2 space-y-2">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs font-mono">
            <span className="text-muted">expected</span>
            <span className="text-fg">{sim.expectedTool}</span>
            <span className="text-muted">→</span>
            <span className="text-muted">picked</span>
            <span className={sim.correct ? 'text-success' : 'text-critical'}>{sim.pickedTool}</span>
          </div>

          {Object.keys(sim.pickedArgs).length > 0 && (
            <pre className="thin-scroll text-[11px] text-muted bg-canvas border border-line px-2.5 py-2 rounded
                            whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
              {JSON.stringify(sim.pickedArgs, null, 2)}
            </pre>
          )}
          {sim.argWarning && sim.argIssue && (
            <p className="text-xs text-warning/90 leading-snug">
              <span className="font-semibold uppercase tracking-wide text-[10px] text-warning/70 mr-1">
                {sim.argIssueType === 'schema' ? 'schema violation (programmatic):' : 'value quality warning (heuristic):'}
              </span>
              {sim.argIssue}
            </p>
          )}
          {fix && <SuggestedFixBox fix={fix} />}
        </div>
      </CollapsiblePanel>
    </div>
  );
}

// ─── Tab content panels ────────────────────────────────────────────────────────

function ExecutiveSummaryTab({ summary }: { summary: ReportSummary }) {
  const protocolOk = summary.protocolTotal > 0 && summary.protocolPassed === summary.protocolTotal;
  const behaviorTone = summary.behaviorLabel === 'Strong' ? 'good' : summary.behaviorLabel === 'Weak' ? 'bad' : 'neutral';
  const compatibilityOk = summary.layer2Ran && summary.compatibilityTotal > 0 && summary.compatibilityPassed === summary.compatibilityTotal;

  const protocolFraction = summary.protocolTotal > 0 ? summary.protocolPassed / summary.protocolTotal : 1;
  const compatibilityFraction = summary.compatibilityTotal > 0 ? summary.compatibilityPassed / summary.compatibilityTotal : 0;
  const behaviorFraction = summary.clarityAverage !== null ? summary.clarityAverage / 10 : 0;
  const behaviorValue = summary.clarityAverage !== null
    ? `${summary.clarityAverage.toFixed(1)}/10 · ${summary.behaviorLabel}`
    : summary.behaviorLabel;

  // Staged entrance for the first paint of a freshly-loaded report: gauge/badge,
  // then the stat cards with a slight stagger, then the rest. Fires once on
  // mount (this component mounts exactly when a report finishes loading) and
  // never replays on later tab revisits — after the sequence finishes, the
  // animation classes are dropped so nothing here keeps re-animating.
  const [animateIn, setAnimateIn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setAnimateIn(false), 450);
    return () => clearTimeout(t);
  }, []);
  const stageStyle = (delayMs: number) => animateIn ? { animationDelay: `${delayMs}ms` } : undefined;
  const stageCls = animateIn ? 'fade-slide-in' : '';

  return (
    <div className="space-y-5">
      <div className={`flex items-center gap-5 flex-wrap ${stageCls}`} style={stageStyle(0)}>
        <HealthGauge score={summary.healthScore} status={summary.productionStatus} />
        <div>
          <div className="text-[11px] text-muted uppercase tracking-wide mb-1.5">Overall Health</div>
          <ProductionStatusBadge status={summary.productionStatus} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className={stageCls} style={stageStyle(60)}>
          <LayerStatCard
            label="Protocol"
            value={`${summary.protocolPassed}/${summary.protocolTotal} Passed`}
            fraction={protocolFraction}
            tone={protocolOk ? 'good' : 'bad'}
          />
        </div>
        {summary.capacityLimited ? (
          <div className={`sm:col-span-2 ${stageCls}`} style={stageStyle(100)}>
            <AiCapacityBanner />
          </div>
        ) : (
          <>
            <div className={stageCls} style={stageStyle(100)}>
              <LayerStatCard
                label="Behavior"
                value={behaviorValue}
                fraction={summary.layer2Ran ? behaviorFraction : 0}
                tone={summary.layer2Ran ? behaviorTone : 'neutral'}
              />
            </div>
            <div className={stageCls} style={stageStyle(140)}>
              <LayerStatCard
                label="Compatibility"
                value={!summary.layer2Ran ? 'Not run' : summary.compatibilityTotal > 0 ? `${summary.compatibilityPassed}/${summary.compatibilityTotal} Passed` : 'No scenarios'}
                fraction={summary.layer2Ran ? compatibilityFraction : 0}
                tone={summary.layer2Ran ? (compatibilityOk ? 'good' : 'neutral') : 'neutral'}
                split={summary.layer2Ran && summary.compatibilityTotal > 0}
              />
            </div>
          </>
        )}
      </div>

      <div className={`space-y-5 ${stageCls}`} style={stageStyle(180)}>
        {!summary.capacityLimited && (
          <div className="grid grid-cols-3 gap-3 max-w-md">
            <CountBadge label="Critical" count={summary.criticalCount} tone="critical" />
            <CountBadge label="Warnings" count={summary.warningCount} tone="warning" />
            <CountBadge label="Suggestions" count={summary.suggestionCount} tone="suggestion" />
          </div>
        )}

        <p className="text-sm text-fg/80 leading-snug">{execSummaryLine(summary)}</p>

        {summary.highlights.length > 0 && (
          <div className="space-y-1">
            {summary.highlights.map(h => (
              <div key={h} className="text-xs text-success flex items-center gap-1.5">
                <span>✓</span><span>{h}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProtocolTab({ report, expandedKeys, onToggle, setKeysExpanded }: {
  report: Layer1Report; expandedKeys: Set<string>; onToggle: (key: string) => void; setKeysExpanded: (keys: string[], expand: boolean) => void;
}) {
  const passed = report.results.filter(r => r.schemaPassed).length;
  const total = report.results.length;
  const allKeys = report.results.map(r => `l1:${r.name}`);
  const allExpanded = allKeys.length > 0 && allKeys.every(k => expandedKeys.has(k));

  return (
    <div className="space-y-4">
      <LayerSectionHeader
        title="Layer 1 · Protocol Validation"
        passed={passed}
        total={total}
        description="Validates each tool's JSON schema against the MCP protocol spec — malformed schemas cause hard errors when an agent calls the tool."
        allExpanded={allExpanded}
        onToggleAll={() => setKeysExpanded(allKeys, !allExpanded)}
      />

      {report.noToolsCapability && (
        <div className="bg-surface border border-line border-l-4 border-l-warning rounded p-3 text-warning text-sm">
          This server does not advertise tool support.
        </div>
      )}

      {total > 0 && passed === total ? (
        <EmptyState message={`All ${total} tool${total !== 1 ? 's' : ''} passed schema validation with no issues.`} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 items-start">
          {report.results.map((tool, i) => {
            const key = `l1:${tool.name}`;
            return (
              <Layer1ToolRow key={tool.name} tool={tool} index={i} total={total}
                expanded={expandedKeys.has(key)} onToggle={() => onToggle(key)} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function BehaviorTab({ report, expandedKeys, onToggle, setKeysExpanded }: {
  report: Layer2Report; expandedKeys: Set<string>; onToggle: (key: string) => void; setKeysExpanded: (keys: string[], expand: boolean) => void;
}) {
  const clarityWarnCount = report.clarity.filter(c => claritySeverity(c.score) === 'warning').length;
  const highConfusion = report.confusedPairs.filter(p => p.severity === 'HIGH').length;
  const clean = clarityWarnCount === 0 && highConfusion === 0;
  const fixByName = new Map(report.suggestedFixes.map(f => [f.name, f]));
  const allKeys = report.clarity.map(c => `l2:${c.name}`);
  const allExpanded = allKeys.length > 0 && allKeys.every(k => expandedKeys.has(k));

  return (
    <div className="space-y-6">
      <LayerSectionHeader
        title="Layer 2 · Behavior Validation"
        passed={report.clarity.length - clarityWarnCount}
        total={report.clarity.length}
        description="Checks whether tool descriptions are clear and distinct enough for an LLM agent to reliably pick the right one."
        allExpanded={allExpanded}
        onToggleAll={() => setKeysExpanded(allKeys, !allExpanded)}
      />

      {clean && report.clarity.length > 0 ? (
        <EmptyState message={`All ${report.clarity.length} tool${report.clarity.length !== 1 ? 's' : ''} passed with no clarity or ambiguity issues.`} />
      ) : (
        <div className="space-y-2.5">
          {report.clarity.map(r => {
            const key = `l2:${r.name}`;
            return (
              <ToolCard key={r.name} result={r} fix={fixByName.get(r.name)}
                expanded={expandedKeys.has(key)} onToggle={() => onToggle(key)} />
            );
          })}
        </div>
      )}

      <div>
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">Ambiguity Analysis</h3>
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
    </div>
  );
}

function CompatibilityTab({ report, expandedKeys, onToggle, setKeysExpanded }: {
  report: Layer2Report; expandedKeys: Set<string>; onToggle: (key: string) => void; setKeysExpanded: (keys: string[], expand: boolean) => void;
}) {
  const total = report.simulation.length;
  const passed = report.simulationScore;
  const failCount = report.simulation.filter(s => !s.correct).length;
  const warnCount = report.simulation.filter(s => s.correct && s.argWarning).length;
  const clean = failCount === 0 && warnCount === 0;
  const allKeys = report.simulation.map((_, i) => `l3:${i}`);
  const allExpanded = allKeys.length > 0 && allKeys.every(k => expandedKeys.has(k));
  const fixByScenario = new Map(
    report.suggestedFixes.filter(f => f.scenarioContext).map(f => [f.scenarioContext!.scenarioIndex, f]),
  );

  return (
    <div className="space-y-4">
      <LayerSectionHeader
        title="Layer 3 · Compatibility Testing"
        passed={passed}
        total={total}
        description="Simulates real user requests against a live agent to confirm it selects the correct tool and arguments."
        allExpanded={allExpanded}
        onToggleAll={() => setKeysExpanded(allKeys, !allExpanded)}
      />

      {clean && total > 0 ? (
        <EmptyState message={`All ${total} scenario${total !== 1 ? 's' : ''} passed with no issues.`} />
      ) : (
        <div className="space-y-2.5">
          {report.simulation.map((sim, i) => {
            const key = `l3:${i}`;
            return (
              <SimulationRow key={i} sim={sim} index={i} fix={fixByScenario.get(i + 1)}
                expanded={expandedKeys.has(key)} onToggle={() => onToggle(key)} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function VerdictTab({ summary }: { summary: ReportSummary }) {
  const s = PRODUCTION_STATUS_STYLE[summary.productionStatus];
  const accentCls =
    summary.productionStatus === 'ready' ? 'border-l-success' :
    summary.productionStatus === 'minor' ? 'border-l-warning' :
    summary.productionStatus === 'incomplete' ? 'border-l-suggestion' : 'border-l-critical';
  const paragraph = verdictExplanation(summary).join(' ');

  return (
    <div className="space-y-4">
      <div className={`bg-surface border border-line border-l-4 ${accentCls} rounded p-5`}>
        <div className="flex items-center gap-2.5 text-lg font-bold mb-3">
          <span>{s.emoji}</span><span className="text-fg">{s.label}</span>
        </div>
        <p className="text-sm text-fg/80 leading-relaxed mb-4">{paragraph}</p>
        {!summary.capacityLimited && (
          <div className="grid grid-cols-3 gap-3 max-w-md">
            <CountBadge label="Critical" count={summary.criticalCount} tone="critical" />
            <CountBadge label="Warnings" count={summary.warningCount} tone="warning" />
            <CountBadge label="Suggestions" count={summary.suggestionCount} tone="suggestion" />
          </div>
        )}
      </div>

      {!summary.capacityLimited && (
        <Callout tone="info">
          &ldquo;Ready for Production&rdquo; means schema valid and tested model selected the correct tool across
          generated scenarios. Not exhaustive testing across all models or all user phrasings.
        </Callout>
      )}
    </div>
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
        className="text-xs px-3 py-1.5 rounded border border-line text-muted
                   hover:text-fg hover:border-suggestion/50 transition-colors font-mono flex items-center gap-1"
      >
        Export <span className="text-[8px]">▾</span>
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

// Rendered only in print output — the tab bar and header buttons are hidden on paper.
function PrintHeader({ serverName }: { serverName: string }) {
  return (
    <div className="hidden print:block mb-4 pb-2 border-b border-line">
      <h1 className="text-lg font-bold text-fg">MCP Checker Report — {serverName}</h1>
      <p className="text-sm text-muted">{new Date().toLocaleString()}</p>
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

type TabId = 'summary' | 'protocol' | 'behavior' | 'compatibility' | 'verdict';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'summary', label: 'Executive Summary' },
  { id: 'protocol', label: 'Protocol' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'compatibility', label: 'Compatibility' },
  { id: 'verdict', label: 'Verdict' },
];

// Panels stay mounted at all times (only visibility toggles) so an inactive tab's
// scroll/expand state survives switching, and so PDF export — which forces every
// panel visible via the `print:` override below — can print the full report
// regardless of which tab was active when Export was clicked.
function tabPanelClass(id: TabId, active: TabId, pageBreak = true): string {
  if (active === id) return 'block tab-fade-in';
  return `hidden print:block print:mt-8${pageBreak ? ' print:break-before-page' : ''}`;
}

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll-fade hint for narrow viewports where the tab strip overflows and
  // clips tabs (e.g. "Verdict") off-screen with no other affordance that
  // more tabs exist. Driven by actual scroll position rather than a
  // breakpoint, so it naturally stays off whenever every tab already fits.
  const [fade, setFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateFade = () => {
      setFade({
        left: el.scrollLeft > 1,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    updateFade();
    el.addEventListener('scroll', updateFade, { passive: true });
    const observer = new ResizeObserver(updateFade);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', updateFade);
      observer.disconnect();
    };
  }, []);

  const move = (dir: 1 | -1) => {
    const idx = TABS.findIndex(t => t.id === active);
    const next = TABS[(idx + dir + TABS.length) % TABS.length];
    onChange(next.id);
    btnRefs.current[next.id]?.focus();
  };

  return (
    <div className="relative border-b border-line print-hide">
      <div ref={scrollRef} role="tablist" aria-label="Report sections"
        className="flex items-center gap-1 px-4 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            ref={el => { btnRefs.current[t.id] = el; }}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={e => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
            }}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${
              active === t.id ? 'border-suggestion text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 left-0 w-8
        bg-gradient-to-r from-canvas to-transparent transition-opacity duration-150 ${fade.left ? 'opacity-100' : 'opacity-0'}`} />
      <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 w-8
        bg-gradient-to-l from-canvas to-transparent transition-opacity duration-150 ${fade.right ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────

function ReportHeader({ url, authHeader, onExport, showExport }: {
  url: string; authHeader: string; onExport: (format: ExportFormat) => void; showExport: boolean;
}) {
  const displayUrl = url.replace(/^https?:\/\//, '');
  const reanalyzeParams = new URLSearchParams({ url });
  if (authHeader) reanalyzeParams.set('auth', authHeader);

  return (
    <header className="border-b border-line px-4 py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="font-mono text-lg sm:text-xl text-fg font-medium truncate">{displayUrl}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 print-hide">
          <Link href={`/check?${reanalyzeParams.toString()}`}
            className="text-xs px-3 py-1.5 rounded border border-line text-muted
                       hover:text-fg hover:border-suggestion/50 transition-colors whitespace-nowrap">
            Re-analyze
          </Link>
          {showExport && <ExportMenu onExport={onExport} />}
        </div>
      </div>
    </header>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function ReportSidebar({ layer1, scanDurationMs, scannedAt, activeTab }: {
  layer1: Layer1Report; scanDurationMs: number | null; scannedAt: Date | null; activeTab: TabId;
}) {
  // The Claude-only testing disclosure is report-level context, not per-layer
  // detail — showing it on every tab just repeats the same sentence five
  // times, so it's reserved for the tabs that talk about the overall verdict.
  const showTestedAgainst = activeTab === 'summary' || activeTab === 'verdict';

  return (
    <aside className="space-y-4">
      <div className="bg-surface border border-line rounded p-3">
        <h3 className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-2">Report Information</h3>
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Server Name</dt>
            <dd className="font-mono text-fg text-right truncate">{layer1.serverName ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Tools Validated</dt>
            <dd className="font-mono text-fg">{layer1.toolCount}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scan Duration</dt>
            <dd className="font-mono text-fg">{scanDurationMs !== null ? formatDuration(scanDurationMs) : '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scanned At</dt>
            <dd className="font-mono text-fg text-right">{scannedAt ? scannedAt.toLocaleString() : '—'}</dd>
          </div>
        </dl>
      </div>

      {showTestedAgainst && (
        <Callout tone="info" title="Tested Against">
          This report validates tool-selection behavior for Claude-based agents. Results for other models
          (GPT-4, Gemini, etc.) may vary — multi-model testing is on the roadmap.
        </Callout>
      )}
    </aside>
  );
}

// ─── Loading ────────────────────────────────────────────────────────────────

function LoadingSteps({ steps, currentIndex }: { steps: string[]; currentIndex: number }) {
  return (
    <div className="bg-surface border border-line rounded p-4 space-y-2.5">
      {steps.map((label, i) => {
        const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
        return (
          <div key={label} className="flex items-center gap-2.5 text-sm">
            <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
              {state === 'done' && <span className="text-success text-xs">✓</span>}
              {state === 'active' && (
                <svg className="animate-spin h-3.5 w-3.5 text-suggestion" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {state === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-line" />}
            </span>
            <span className={state === 'active' ? 'text-fg font-medium' : state === 'done' ? 'text-muted' : 'text-muted/50'}>
              {label}
            </span>
          </div>
        );
      })}
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

  const [activeTab, setActiveTab] = useState<TabId>('summary');

  // Which tool cards are expanded, keyed "l1:<name>" / "l2:<name>" / "l3:<index>"
  // so Protocol, Behavior, and Compatibility cards never collide. Centralized
  // here (rather than local state per card) so Expand All / Collapse All can
  // drive every card in a tab at once, and PDF export can force everything open.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleKey = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const setKeysExpanded = (keys: string[], expand: boolean) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      keys.forEach(k => { if (expand) next.add(k); else next.delete(k); });
      return next;
    });
  };

  // Seed default-expanded cards (failed schemas, warning-level clarity, failed
  // or warning-level scenarios) the moment each dataset arrives, without
  // clobbering any manual toggles made since.
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
      layer2.simulation.forEach((s, i) => { if (simulationSeverity(s)) next.add(`l3:${i}`); });
      return next;
    });
  }, [layer2]);

  const allCardKeys = (): string[] => {
    const keys: string[] = [];
    if (layer1) layer1.results.forEach(r => keys.push(`l1:${r.name}`));
    if (layer2) layer2.clarity.forEach(c => keys.push(`l2:${c.name}`));
    if (layer2) layer2.simulation.forEach((_, i) => keys.push(`l3:${i}`));
    return keys;
  };
  const expandAll = () => setExpandedKeys(new Set(allCardKeys()));

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Sequential loading messages. The real network calls are just two fetches
  // (Layer 1, then Layer 2), so most of these are a timed progression rather
  // than a distinct backend event — each interval is cleared the moment the
  // fetch actually resolves either way.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (!layer1Loading) return;
    const id = setInterval(() => setTick(t => Math.min(t + 1, 2)), 700);
    return () => clearInterval(id);
  }, [layer1Loading]);

  const [layer1JustFinished, setLayer1JustFinished] = useState(false);
  useEffect(() => {
    if (!layer1 || layer1Loading) return;
    setLayer1JustFinished(true);
    const t = setTimeout(() => setLayer1JustFinished(false), 400);
    return () => clearTimeout(t);
  }, [layer1, layer1Loading]);

  const [tick2, setTick2] = useState(0);
  useEffect(() => {
    setTick2(0);
    if (!layer2Loading) return;
    const id = setInterval(() => setTick2(t => Math.min(t + 1, 1)), 1200);
    return () => clearInterval(id);
  }, [layer2Loading]);

  const loadingStepsList = runAi
    ? ['Connecting to MCP server', 'Performing handshake', 'Discovering tools', 'Layer 1 · Protocol validation', 'Layer 2 · Behavior validation', 'Layer 3 · Compatibility testing']
    : ['Connecting to MCP server', 'Performing handshake', 'Discovering tools', 'Layer 1 · Protocol validation'];

  const currentStepIndex =
    layer1Loading ? tick :
    layer1JustFinished ? 3 :
    layer2Loading ? 4 + tick2 :
    loadingStepsList.length - 1;

  const scanStartRef = useRef<number | null>(null);
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!url) { router.push('/check'); return; }

    scanStartRef.current = Date.now();
    setScanDurationMs(null);
    setScannedAt(null);

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

  useEffect(() => {
    if (dataReady && scanDurationMs === null && scanStartRef.current !== null) {
      setScanDurationMs(Date.now() - scanStartRef.current);
      setScannedAt(new Date());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady]);

  // Brief "Generating report..." beat between the last fetch resolving and the
  // report appearing — the final loading step, not a real async gap.
  const [finalizing, setFinalizing] = useState(false);
  useEffect(() => {
    if (!dataReady) return;
    setFinalizing(true);
    const t = setTimeout(() => setFinalizing(false), 350);
    return () => clearTimeout(t);
  }, [dataReady]);

  const isDailyCap = layer2Error === DAILY_CAP_MESSAGE;
  const summary = dataReady && !finalizing && layer1 ? computeReportSummary(layer1, layer2, isDailyCap) : null;

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

  return (
    <div className="min-h-screen bg-canvas">
      <ReportHeader
        url={url}
        authHeader={authHeader}
        onExport={handleExport}
        showExport={!!summary}
      />

      {summary && layer1 && <TabBar active={activeTab} onChange={setActiveTab} />}

      <main className="max-w-6xl mx-auto px-4 py-6">
        {summary && layer1 && <PrintHeader serverName={layer1.serverName ?? hostname} />}

        {!summary && (
          <div className="max-w-md mx-auto py-10">
            {layer1Error && !layer1 && !layer1Loading ? (
              <ErrorBox message={layer1Error} defaultHeader="Connection failed" />
            ) : (
              <LoadingSteps steps={loadingStepsList} currentIndex={currentStepIndex} />
            )}
          </div>
        )}

        {summary && layer1 && (
          <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-6">
            <div className="min-w-0">
              <div id="panel-summary" role="tabpanel" aria-labelledby="tab-summary" className={tabPanelClass('summary', activeTab, false)}>
                <ExecutiveSummaryTab summary={summary} />
              </div>

              <div id="panel-protocol" role="tabpanel" aria-labelledby="tab-protocol" className={tabPanelClass('protocol', activeTab)}>
                <ProtocolTab report={layer1} expandedKeys={expandedKeys} onToggle={toggleKey} setKeysExpanded={setKeysExpanded} />
              </div>

              <div id="panel-behavior" role="tabpanel" aria-labelledby="tab-behavior" className={tabPanelClass('behavior', activeTab)}>
                {isDailyCap ? (
                  <AiCapacityBanner />
                ) : layer2Error ? (
                  <ErrorBox message={layer2Error} defaultHeader="Behavior validation failed" />
                ) : layer2 ? (
                  <BehaviorTab report={layer2} expandedKeys={expandedKeys} onToggle={toggleKey} setKeysExpanded={setKeysExpanded} />
                ) : (
                  <p className="text-sm text-muted py-10 text-center">Behavior validation was not run for this scan.</p>
                )}
              </div>

              <div id="panel-compatibility" role="tabpanel" aria-labelledby="tab-compatibility" className={tabPanelClass('compatibility', activeTab)}>
                {isDailyCap ? (
                  <AiCapacityBanner />
                ) : layer2Error ? (
                  <ErrorBox message={layer2Error} defaultHeader="Compatibility testing failed" />
                ) : layer2 ? (
                  <CompatibilityTab report={layer2} expandedKeys={expandedKeys} onToggle={toggleKey} setKeysExpanded={setKeysExpanded} />
                ) : (
                  <p className="text-sm text-muted py-10 text-center">Compatibility testing was not run for this scan.</p>
                )}
              </div>

              <div id="panel-verdict" role="tabpanel" aria-labelledby="tab-verdict" className={tabPanelClass('verdict', activeTab)}>
                <VerdictTab summary={summary} />
              </div>
            </div>

            <ReportSidebar layer1={layer1} scanDurationMs={scanDurationMs} scannedAt={scannedAt} activeTab={activeTab} />
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
