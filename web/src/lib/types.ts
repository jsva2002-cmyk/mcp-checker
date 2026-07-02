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
}

export interface SimulationResult {
  request: string;
  expectedTool: string;
  pickedTool: string;
  pickedArgs: Record<string, unknown>;
  correct: boolean;
}

export interface SuggestedFix {
  name: string;
  originalDescription: string;
  suggestedDescription: string;
}

export interface Layer2Report {
  clarity: ClarityResult[];
  confusedPairs: ConfusionPair[];
  simulation: SimulationResult[];
  simulationScore: number;
  suggestedFixes: SuggestedFix[];
}
