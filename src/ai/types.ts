export interface LLMDecision {
  action:          string;   // what the dwarf will do — shown as task
  reasoning:       string;   // internal monologue shown in EventLog + DwarfPanel
  emotional_state: string;   // flavor text
  expectedOutcome: string;   // used by action awareness to detect surprises
}

export interface CrisisSituation {
  type:          'hunger' | 'morale' | 'resource_contest' | 'low_supplies';
  description:   string;
  colonyContext: string;
}
