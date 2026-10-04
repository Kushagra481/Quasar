import { z } from "zod";
import { Actions, ActionSchema, CauseSchema, SnapshotSchema } from "./contracts";
import type { Action, Cause, Snapshot } from "./contracts";

export const TransitionSchema = z.object({
  state: SnapshotSchema,
  cause: CauseSchema,
  action: ActionSchema,
  reward: z.number().finite(),
  nextState: SnapshotSchema,
  nextCause: CauseSchema,
  terminal: z.boolean(),
});
export type Transition = z.infer<typeof TransitionSchema>;
export const PolicySchema = z.object({
  version: z.literal(1),
  name: z.string(),
  dataset: z.string(),
  trainedAt: z.string().datetime(),
  alpha: z.number().positive().max(1),
  gamma: z.number().nonnegative().max(1),
  epochs: z.number().int().positive(),
  updates: z.number().int().nonnegative(),
  q: z.record(z.string(), z.record(z.string(), z.number().finite())),
});
export type PolicyModel = z.infer<typeof PolicySchema>;

export function features(snapshot: Snapshot, cause: Cause): string {
  const severity = snapshot.services.some(s => s.status === "down") ? "down"
    : snapshot.services.some(s => s.status !== "healthy") ? "degraded" : "healthy";
  return `${cause}|${severity}`;
}
export function seeded(seed = 42): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
export class QPolicy {
  constructor(readonly model: PolicyModel) {}
  choose(snapshot: Snapshot, cause: Cause, supported: readonly Action[]): Action {
    const row = this.model.q[features(snapshot, cause)];
    if (!row || !supported.some(a => row[a] !== undefined)) return "inspect";
    return supported.reduce((best, a) =>
      (row[a] ?? -Infinity) > (row[best] ?? -Infinity) ? a : best, supported[0] ?? "inspect");
  }
}
export function train(
  transitions: Transition[], dataset: string,
  epochs = 200, seed = 42, alpha = 0.15, gamma = 0.9,
): PolicyModel {
  if (!transitions.length) throw new Error("Training dataset is empty.");
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 10000) throw new Error("epochs must be 1..10000.");
  const random = seeded(seed);
  const q: PolicyModel["q"] = {};
  const row = (key: string) => q[key] ??= Object.fromEntries(Actions.map(a => [a, 0]));
  for (let e = 0; e < epochs; e++) {
    const shuffled = [...transitions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    for (const t of shuffled) {
      const values = row(features(t.state, t.cause));
      const next = t.terminal ? 0 : Math.max(...Object.values(row(features(t.nextState, t.nextCause))));
      values[t.action] = values[t.action]! + alpha * (t.reward + gamma * next - values[t.action]!);
    }
  }
  return PolicySchema.parse({
    version: 1, name: `q-learning-${seed}-${epochs}`, dataset, trainedAt: new Date().toISOString(),
    alpha, gamma, epochs, updates: epochs * transitions.length, q,
  });
}
export function evaluateTransitions(model: PolicyModel, transitions: Transition[], seed = 73) {
  const random = seeded(seed);
  const policy = new QPolicy(model);
  const states = new Map<string, Transition[]>();
  for (const t of transitions) {
    const key = JSON.stringify([t.state, t.cause]);
    const rows = states.get(key) ?? [];
    rows.push(t);
    states.set(key, rows);
  }
  if (!states.size) throw new Error("Evaluation dataset is empty.");
  let chosenReward = 0, randomReward = 0, learnedResolved = 0, randomResolved = 0;
  for (const rows of states.values()) {
    const first = rows[0]!;
    const available = rows.map(r => r.action);
    const action = policy.choose(first.state, first.cause, available);
    const chosen = rows.find(r => r.action === action)!;
    const baseline = rows[Math.floor(random() * rows.length)]!;
    chosenReward += chosen.reward;
    randomReward += baseline.reward;
    learnedResolved += Number(chosen.terminal && chosen.nextCause === "healthy");
    randomResolved += Number(baseline.terminal && baseline.nextCause === "healthy");
  }
  const count = states.size;
  return {
    dataset: model.dataset, method: "one-step logged transition evaluation",
    states: count, policy: model.name,
    learned: { meanReward: chosenReward / count, resolutionRate: learnedResolved / count },
    randomBaseline: { meanReward: randomReward / count, resolutionRate: randomResolved / count },
    warning: "A synthetic or training-set evaluation is not an LO2 benchmark. No debugging-time claim is derived here.",
  };
}