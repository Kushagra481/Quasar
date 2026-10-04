import { randomUUID } from "node:crypto";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { defaultSafety, healthy, redact } from "./contracts";
import type {
  Action, AuditEvent, Diagnosis, Reasoner, RunResult, RunStatus,
  RuntimeAdapter, SafetyOptions, Snapshot,
} from "./contracts";
import { QPolicy } from "./policy";
import { checkAction } from "./safety";

const State = Annotation.Root({
  snapshot: Annotation<Snapshot>(),
  diagnosis: Annotation<Diagnosis>(),
  action: Annotation<Action>(),
  status: Annotation<RunStatus>(),
  iteration: Annotation<number>(),
  mutations: Annotation<number>(),
  reward: Annotation<number>(),
  toolEvidence: Annotation<string[]>({
    default: () => [],
    reducer: (previous, incoming) => [...previous, ...incoming].slice(-5),
  }),
});

export async function runAgent(
  adapter: RuntimeAdapter, reasoner: Reasoner, policy: QPolicy,
  safety: Partial<SafetyOptions> = {},
): Promise<RunResult> {
  const options = { ...defaultSafety, ...safety };
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 20 ||
      !Number.isInteger(options.maxMutations) || options.maxMutations < 0 || options.maxMutations > 5 ||
      options.minConfidence < 0 || options.minConfidence > 1 ||
      options.verificationAttempts < 1 || options.verificationAttempts > 10 ||
      options.verificationDelayMs < 0 || options.verificationDelayMs > 30000) {
    throw new Error("Invalid bounded safety configuration.");
  }
  const id = randomUUID();
  const started = Date.now();
  const steps: AuditEvent[] = [];
  let before: Snapshot | null = null, after: Snapshot | null = null;
  let diagnosis: Diagnosis | null = null, proposedAction: Action | null = null;
  let mutations = 0, reward = 0;
  const audit = (node: string, message: string, action?: Action, target?: string) => {
    steps.push({ at: new Date().toISOString(), node, message: redact(message), action, target });
  };
  const graph = new StateGraph(State)
    .addNode("observe", async () => {
      const snapshot = await adapter.snapshot();
      before ??= snapshot;
      after = snapshot;
      audit("observe", `Observed ${snapshot.services.length} services from ${snapshot.source}.`);
      return { snapshot, status: healthy(snapshot) ? "resolved" as const : "running" as const };
    })
    .addNode("diagnose", async (s: typeof State.State) => {
      diagnosis = await reasoner.diagnose(s.snapshot, s.toolEvidence);
      audit("diagnose", `${diagnosis.cause}: ${diagnosis.summary} (confidence ${diagnosis.confidence})`,
        undefined, diagnosis.target);
      return { diagnosis };
    })
    .addNode("select", (s: typeof State.State) => {
      proposedAction = policy.choose(s.snapshot, s.diagnosis.cause, adapter.supported);
      audit("select", `Policy ${policy.model.name} selected ${proposedAction}.`,
        proposedAction, s.diagnosis.target);
      return { action: proposedAction, iteration: s.iteration + 1 };
    })
    .addNode("gate", (s: typeof State.State) => {
      const decision = checkAction(s.action, s.diagnosis, adapter, options, s.mutations);
      audit("gate", decision.reason, s.action, s.diagnosis.target);
      return { status: !decision.allowed ? "proposed" as const
        : s.action === "escalate" ? "escalated" as const : "running" as const };
    })
    .addNode("execute", async (s: typeof State.State) => {
      // Recheck immediately before every tool invocation; never trust model output as authorization.
      const decision = checkAction(s.action, s.diagnosis, adapter, options, s.mutations);
      if (!decision.allowed) throw new Error(decision.reason);
      if (s.action !== "inspect") {
        mutations++;
      }
      const result = await adapter.execute(s.action, s.diagnosis.target);
      reward -= s.action === "inspect" ? 0.5 : s.action === "restart" ? 1 : 2;
      audit("execute", result.slice(0, 4000), s.action, s.diagnosis.target);
      return { mutations, reward, toolEvidence: [redact(result).slice(0, 4000)] };
    })
    .addNode("verify", async (s: typeof State.State) => {
      for (let attempt = 0; attempt < (s.action === "inspect" ? 1 : options.verificationAttempts); attempt++) {
        if (attempt || s.action !== "inspect") {
          await new Promise(resolve => setTimeout(resolve, options.verificationDelayMs));
        }
        after = await adapter.snapshot();
        if (healthy(after)) break;
      }
      const recovered = healthy(after!);
      if (recovered) reward += 10;
      const exhausted = s.iteration >= options.maxSteps;
      audit("verify", recovered ? "All observed services meet readiness / health criteria."
        : exhausted ? "Not recovered: step budget exhausted; escalate to operator."
          : "Recovery not verified. Re-observe before choosing the next step.");
      return { snapshot: after!, reward,
        status: recovered ? "resolved" as const : exhausted ? "escalated" as const : "running" as const };
    })
    .addEdge(START, "observe")
    .addConditionalEdges("observe", (s: typeof State.State) => s.status === "resolved" ? END : "diagnose")
    .addEdge("diagnose", "select")
    .addEdge("select", "gate")
    .addConditionalEdges("gate", (s: typeof State.State) => s.status === "running" ? "execute" : END)
    .addEdge("execute", "verify")
    .addConditionalEdges("verify", (s: typeof State.State) => s.status === "running" ? "observe" : END)
    .compile();

  let status: RunResult["status"] = "failed";
  let error: string | null = null;
  try {
    const result = await graph.invoke(
      { status: "running", iteration: 0, mutations: 0, reward: 0 },
      { recursionLimit: options.maxSteps * 7 + 5 },
    );
    status = result.status === "running" ? "escalated" : result.status;
  } catch (cause) {
    // Do not leak provider errors containing credentials or raw infrastructure stderr.
    error = redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 2000);
    audit("error", error);
  }
  return {
    id, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, adapter: adapter.name, reasoner: reasoner.name,
    policyVersion: policy.model.name, status, diagnosis, proposedAction,
    mutations, reward, steps, before, after, error,
  };
}