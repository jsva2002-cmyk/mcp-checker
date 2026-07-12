export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  title?: string;
}

export interface ToolSchemaResult {
  name: string;
  title?: string;
  description?: string;
  schemaPassed: boolean;
  schemaErrors?: string[];
}

export interface Layer1Report {
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  results: ToolSchemaResult[];
  tools: ToolInfo[];
  noToolsCapability?: boolean;
}

export interface ClarityResult {
  name: string;
  score: number;
  verdict: string;
}

export interface ConfusionPair {
  tool1: string;
  tool2: string;
  reason: string;
  severity: 'HIGH' | 'LOW';
  confirmedByScenario?: number;   // 1-based index into Layer2Report.simulation
  confirmedByPickedTool?: string; // tool actually picked in that scenario
}

export interface SimulationResult {
  request: string;
  expectedTool: string;
  pickedTool: string;
  pickedArgs: Record<string, unknown>;
  correct: boolean;
  argWarning?: boolean;                   // right tool picked, but arguments look wrong
  argIssue?: string;                      // one-line reason when argWarning is true
  argIssueType?: 'schema' | 'value';      // schema = programmatic Zod validation; value = LLM heuristic
}

export interface ScenarioFailureContext {
  scenarioIndex: number; // 1-based index into Layer2Report.simulation
  request: string;
  pickedTool: string;
}

export interface SuggestedFix {
  name: string;
  originalDescription: string;
  suggestedDescription: string;
  reasons: Array<'clarity' | 'scenario'>;
  scenarioContext?: ScenarioFailureContext;
}

export interface Layer2Verdict {
  readyTools: number;
  totalTools: number;
  scenariosFailed: number;
  issuesCount: number;
  shipReady: boolean;
}

export interface Layer2Report {
  clarity: ClarityResult[];
  confusedPairs: ConfusionPair[];
  simulation: SimulationResult[];
  simulationScore: number;
  suggestedFixes: SuggestedFix[];
  verdict: Layer2Verdict;
}
