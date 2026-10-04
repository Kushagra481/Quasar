import type { Action, Diagnosis, RuntimeAdapter, SafetyOptions } from "./contracts";

export function checkAction(
  action: Action, diagnosis: Diagnosis, adapter: RuntimeAdapter,
  options: SafetyOptions, mutations: number,
): { allowed: boolean; reason: string } {
  if (!adapter.targets.includes(diagnosis.target)) {
    return { allowed: false, reason: "Target is not in the operator-provided allowlist." };
  }
  if (!adapter.supported.includes(action)) {
    return { allowed: false, reason: `Adapter ${adapter.name} does not support ${action}.` };
  }
  if (action === "inspect" || action === "escalate") {
    return { allowed: true, reason: "Read-only inspection or operator escalation." };
  }
  if (!options.apply) return { allowed: false, reason: "Observe-only mode: mutation requires --apply." };
  if (diagnosis.confidence < options.minConfidence) {
    return { allowed: false, reason: "Diagnosis confidence is below the safety threshold." };
  }
  if (mutations >= options.maxMutations) {
    return { allowed: false, reason: "Mutation budget exhausted." };
  }
  if (action === "rollback" && !options.allowRollback) {
    return { allowed: false, reason: "Rollback requires the separate --allow-rollback opt-in." };
  }
  return { allowed: true, reason: "Allowlisted action within confidence and mutation limits." };
}