import type { SupportStatus } from '@aftermath/contracts';

export interface DiagnosticCase {
  id: string;
  description: string;
  precompleted: string[];
  withdrawals: Array<{ id: string; reason: string }>;
  expectedDiagnostic: string | null;
  beforeStates: Record<string, SupportStatus>;
  afterStates: Record<string, SupportStatus>;
  newEvidenceId: string | null;
  reviewNotes: string[];
}
const supported = {
  'C1-v1': 'supported',
  'C2-v1': 'supported',
  'C3-v1': 'supported',
  'C4-v1': 'supported',
  'C5-v1': 'supported',
} as const;
const withoutPool = { ...supported, 'C2-v1': 'unsupported', 'C3-v1': 'unsupported' } as const;
const withoutPayment = { ...supported, 'C4-v1': 'unsupported', 'C5-v1': 'unsupported' } as const;
const staging = {
  id: 'E1-v1',
  reason: 'The imported database log belongs to staging, not this production incident.',
};

/** Independent expected choices/states for development conditions of one synthetic incident family. */
export function diagnosticCases(): DiagnosticCase[] {
  return [
    {
      id: 'pool-followup',
      description:
        'The staging import is withdrawn and its environment has already been checked. A production pool check is the remaining relevant diagnostic.',
      precompleted: ['source-environment'],
      withdrawals: [staging],
      expectedDiagnostic: 'production-pool',
      beforeStates: { ...withoutPool },
      afterStates: { ...withoutPool, 'C6-v1': 'supported' },
      newEvidenceId: 'E7-v1',
      reviewNotes: [
        'Database pressure remains unsupported after the staging correction.',
        'The normal production pool observation does not prove the payment provider caused the incident.',
      ],
    },
    {
      id: 'source-check',
      description:
        'The imported database source is withdrawn; the source-environment lookup is the highest-ranked check under the existing coverage/cost heuristic.',
      precompleted: [],
      withdrawals: [staging],
      expectedDiagnostic: 'source-environment',
      beforeStates: { ...withoutPool },
      afterStates: { ...withoutPool },
      newEvidenceId: 'E9-v1',
      reviewNotes: [
        'The metadata lookup confirms staging provenance; it does not restore database support.',
        'Ranking agreement is measured, not the real-world information value of rechecking known metadata.',
      ],
    },
    {
      id: 'payment-support-lost',
      description:
        'Both latency observations are withdrawn while the dependency map remains valid. Payment timeout traces are the relevant available check.',
      precompleted: [],
      withdrawals: [
        { id: 'E3-v1', reason: 'The latency trace export belongs to a different incident window.' },
        { id: 'E4-v1', reason: 'The provider status observation belongs to a different region.' },
      ],
      expectedDiagnostic: 'payment-timeouts',
      beforeStates: { ...withoutPayment },
      afterStates: { ...withoutPayment, 'C7-v1': 'supported' },
      newEvidenceId: 'E8-v1',
      reviewNotes: [
        'The original latency claim remains unsupported; the new trace sample is a separate finding.',
        '108 of 120 sampled failures is an association, not sole-cause proof or a population-wide percentage.',
      ],
    },
    {
      id: 'alternative-survives',
      description:
        'One latency source is withdrawn but its independent alternative survives. No positive-coverage diagnostic is needed.',
      precompleted: [],
      withdrawals: [
        { id: 'E3-v1', reason: 'The latency trace export belongs to a different incident window.' },
      ],
      expectedDiagnostic: null,
      beforeStates: { ...supported },
      afterStates: { ...supported },
      newEvidenceId: null,
      reviewNotes: [
        'The provider status record still supports the latency finding.',
        'The surviving observation does not establish a sole root cause.',
      ],
    },
    {
      id: 'missing-prerequisite',
      description:
        'The service dependency map is withdrawn. The payment check is unavailable and no other diagnostic covers the unresolved recommendation.',
      precompleted: [],
      withdrawals: [
        {
          id: 'E6-v1',
          reason:
            'The dependency map is outdated and cannot establish this deployment’s call path.',
        },
      ],
      expectedDiagnostic: null,
      beforeStates: { ...supported, 'C5-v1': 'unsupported' },
      afterStates: { ...supported, 'C5-v1': 'unsupported' },
      newEvidenceId: null,
      reviewNotes: [
        'Do not recommend the unavailable payment check as if its prerequisite were verified.',
        'Unresolved dependency information should remain explicit; unrelated checks do not resolve it.',
      ],
    },
  ];
}
