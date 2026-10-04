import { z } from "zod";

export const Actions = ["inspect", "restart", "scale", "rollback", "escalate"] as const;
export const Causes = ["healthy", "crash", "resource", "regression", "dependency", "unknown"] as const;
export const FaultSchema = z.enum(["crash", "resource", "regression", "dependency"]);
export const ActionSchema = z.enum(Actions);
export const CauseSchema = z.enum(Causes);
export type Action = z.infer<typeof ActionSchema>;
export type Cause = z.infer<typeof CauseSchema>;
export type Fault = z.infer<typeof FaultSchema>;

export const ServiceSchema = z.object({
  name: z.string().min(1).max(120),
  status: z.enum(["healthy", "degraded", "down", "unknown"]),
  restarts: z.number().int().nonnegative(),
  cpuPercent: z.number().nonnegative().nullable(),
  memoryPercent: z.number().nonnegative().nullable(),
  errorRate: z.number().min(0).max(1).nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  dependencies: z.array(z.string()).max(50),
  logs: z.array(z.string().max(2000)).max(100),
});
export const SnapshotSchema = z.object({
  observedAt: z.string().datetime(),
  source: z.string().max(100),
  services: z.array(ServiceSchema).min(1).max(100),
});
export const DiagnosisSchema = z.object({
  cause: CauseSchema,
  target: z.string().min(1).max(120),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(2000),
  evidence: z.array(z.string().max(2000)).max(10),
});
export type Service = z.infer<typeof ServiceSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export interface RuntimeAdapter {
  readonly name: string;
  readonly targets: readonly string[];
  readonly supported: readonly Action[];
  snapshot(): Promise<Snapshot>;
  execute(action: Action, target: string): Promise<string>;
  close?(): Promise<void>;
}
export interface Reasoner {
  readonly name: string;
  diagnose(snapshot: Snapshot, toolEvidence?: readonly string[]): Promise<Diagnosis>;
}
export interface SafetyOptions {
  apply: boolean;
  allowRollback: boolean;
  minConfidence: number;
  maxMutations: number;
  maxSteps: number;
  verificationAttempts: number;
  verificationDelayMs: number;
}
export const defaultSafety: SafetyOptions = {
  apply: false, allowRollback: false, minConfidence: 0.7, maxMutations: 2,
  maxSteps: 6, verificationAttempts: 3, verificationDelayMs: 1000,
};
export type RunStatus = "running" | "resolved" | "proposed" | "escalated" | "failed";
export interface AuditEvent {
  at: string;
  node: string;
  message: string;
  action?: Action;
  target?: string;
}
export interface RunResult {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  adapter: string;
  reasoner: string;
  policyVersion: string;
  status: Exclude<RunStatus, "running">;
  diagnosis: Diagnosis | null;
  proposedAction: Action | null;
  mutations: number;
  reward: number;
  steps: AuditEvent[];
  before: Snapshot | null;
  after: Snapshot | null;
  error: string | null;
}
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]")
    .replace(/((?:password|token|api[_-]?key|secret)\s*[=:]\s*)[^\s,;"]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
export const healthy = (snapshot: Snapshot): boolean =>
  snapshot.services.every(s => s.status === "healthy" &&
    (s.errorRate === null || s.errorRate <= 0.01));