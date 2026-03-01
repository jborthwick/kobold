export interface LLMDecision {
  action:          string;   // what the goblin will do — shown as task
  intent?:         import('../shared/types').LLMIntent; // structured BT override
  reasoning:       string;   // internal monologue shown in EventLog + GoblinPanel
  emotional_state: string;   // flavor text
  expectedOutcome: string;   // used by action awareness to detect surprises
}

export interface CrisisSituation {
  type:          'hunger' | 'morale' | 'resource_contest' | 'low_supplies' | 'resource_sharing' | 'adventurer_raid' | 'exhaustion' | 'loneliness';
  description:   string;
  colonyContext: string;
}
