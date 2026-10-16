import type { AgentConfig, Claim, Evaluation } from '@aftermath/contracts';
import {
  PROMPT_VERSION,
  type ModelInput,
  type ModelProvider,
  type ModelReply,
} from '@aftermath/agents';

export const testConfig: AgentConfig = {
  provider: 'scripted-test',
  model: 'scripted-test-model',
  promptVersion: PROMPT_VERSION,
  maxCalls: 12,
  maxOutputTokens: 2048,
  maxContextBytes: 64000,
  timeoutMs: 5000,
};
type Bundle = {
  claims: Claim[];
  evaluations: Evaluation[];
  citationOptions: Array<{ claimId: string; options: string[][] }>;
  requestedStatementIds?: string[];
  evidence?: Array<{ id: string }>;
  diagnosticReview?: { relevantRecipeIds: string[] };
};
/** Test double only. Not selectable by the server environment or production UI. */
export class ScriptedProvider implements ModelProvider {
  name = testConfig.provider;
  model = testConfig.model;
  inputs: ModelInput[] = [];
  diagnostic = false;
  endless = false;
  rejectCitations = false;
  skipDiagnosticDecision = false;
  onInvoke?: (input: ModelInput) => Promise<void>;
  buildRequest(input: ModelInput) {
    return structuredClone(input);
  }
  async invoke(request: unknown): Promise<ModelReply> {
    const input = request as ModelInput;
    this.inputs.push(structuredClone(input));
    await this.onInvoke?.(input);
    const readName = input.role === 'investigator' ? 'getEvidenceBundle' : 'getAcceptedFindings';
    const bundle = input.history.findLast((h) => h.name === readName)?.result as Bundle | undefined;
    let name = readName;
    let args: unknown = {};
    if (bundle && !this.endless) {
      const citations = (id: string) => [
        ...new Set(bundle.citationOptions.find((c) => c.claimId === id)!.options.flat()),
      ];
      if (input.role === 'investigator') {
        if (
          this.diagnostic &&
          !bundle.evidence?.some((e) => e.id === 'E7-v1') &&
          input.tools.some((t) => t.name === 'runDiagnostic')
        ) {
          name = 'runDiagnostic';
          args = { recipeId: 'production-pool' };
        } else if (
          !this.skipDiagnosticDecision &&
          input.tools.some((t) => t.name === 'deferDiagnostics')
        ) {
          name = 'deferDiagnostics';
          args = {
            recipeIds: bundle.diagnosticReview!.relevantRecipeIds,
            reason:
              'Scripted test deferral: a human should review the unresolved diagnostic before execution.',
          };
        } else {
          name = 'proposeClaims';
          args = {
            findings: bundle.claims.map((claim) => ({
              claimId: claim.id,
              summary: `Test interpretation of ${claim.title}.`,
              supportGroupIds:
                bundle.evaluations.find((e) => e.claimId === claim.id)!.status === 'supported'
                  ? bundle.evaluations.find((e) => e.claimId === claim.id)!.validGroupIds
                  : [],
              citationIds: citations(claim.id),
              uncertainty: 'Synthetic observation; causal interpretation is unverified.',
            })),
          };
        }
      } else {
        name = 'proposeReport';
        args = {
          statements: bundle.requestedStatementIds!.map((id) => ({
            claimId: id,
            text: `Test reporter wording for ${bundle.claims.find((c) => c.id === id)!.title}.`,
            citationIds: this.rejectCitations ? ['invented-source'] : citations(id),
            uncertainty: 'Synthetic observation; causal interpretation is unverified.',
          })),
        };
      }
    }
    return {
      raw: { testDouble: true, functionCall: { name, arguments: args } },
      calls: [{ name, arguments: args }],
      inputTokens: 120,
      outputTokens: 80,
      error: null,
    };
  }
}
