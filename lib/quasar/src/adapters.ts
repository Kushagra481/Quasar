import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Actions, SnapshotSchema, redact } from "./contracts";
import type { Action, RuntimeAdapter, Service, Snapshot } from "./contracts";

const executeFile = promisify(execFile);
async function command(binary: "docker" | "kubectl", args: string[]): Promise<string> {
  try {
    const result = await executeFile(binary, args, {
      timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
      windowsHide: true, shell: false,
    });
    return redact(result.stdout);
  } catch (error) {
    const result = error as { code?: string | number; stderr?: string };
    throw new Error(`${binary} failed (${result.code ?? "timeout"}): ${redact(result.stderr ?? "Tool unavailable or request failed.").slice(0, 1000)}`);
  }
}
function validTargets(targets: readonly string[]): void {
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length ||
      targets.some(target => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(target))) {
    throw new Error("Provide 1..20 unique, valid, explicitly allowlisted workload/container names.");
  }
}
const logs = (text: string): string[] =>
  text.split("\n").filter(Boolean).slice(-80).map(line => redact(line).slice(0, 2000));

export class DockerAdapter implements RuntimeAdapter {
  readonly name = "docker-cli";
  readonly supported: readonly Action[] = ["inspect", "restart", "escalate"];
  constructor(readonly targets: readonly string[]) { validTargets(targets); }
  async snapshot(): Promise<Snapshot> {
    const services: Service[] = [];
    for (const name of this.targets) {
      const raw = await command("docker", ["inspect", "--format", "{{json .}}", name]);
      const container = JSON.parse(raw) as {
        State: { Running: boolean; OOMKilled: boolean; Health?: { Status: string } };
        RestartCount: number;
      };
      const log = await command("docker", ["logs", "--tail", "80", name]);
      const health = container.State.Health?.Status;
      services.push({
        name, status: !container.State.Running ? "down"
          : health === "healthy" ? "healthy" : health ? "degraded" : "unknown",
        restarts: container.RestartCount ?? 0, cpuPercent: null, memoryPercent: null,
        errorRate: null, latencyMs: null, dependencies: [],
        logs: [...(container.State.OOMKilled ? ["OOM: out of memory event"] : []), ...logs(log)].slice(-80),
      });
    }
    return { observedAt: new Date().toISOString(), source: this.name, services };
  }
  async execute(action: Action, target: string): Promise<string> {
    if (!this.targets.includes(target)) throw new Error("Docker target not allowlisted.");
    if (action === "inspect") return command("docker", ["logs", "--tail", "80", target]);
    if (action === "restart") return command("docker", ["restart", "--time", "10", target]);
    if (action === "escalate") return "Escalated to operator.";
    throw new Error(`Docker adapter does not support ${action}.`);
  }
}

interface Deployment {
  metadata: { generation: number };
  spec: { replicas?: number };
  status?: {
    observedGeneration?: number; updatedReplicas?: number; availableReplicas?: number;
    readyReplicas?: number; conditions?: { type: string; reason: string; status: string }[];
  };
}
export class KubernetesAdapter implements RuntimeAdapter {
  readonly name = "kubernetes-cli";
  readonly supported: readonly Action[] = ["inspect", "restart", "scale", "rollback", "escalate"];
  constructor(
    readonly targets: readonly string[],
    private readonly namespace: string,
    private readonly maxReplicas = 5,
  ) {
    validTargets(targets);
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace) ||
        !Number.isInteger(maxReplicas) || maxReplicas < 1 || maxReplicas > 10) {
      throw new Error("Invalid Kubernetes namespace or maxReplicas (1..10).");
    }
  }
  private kubectl(args: string[]): Promise<string> {
    return command("kubectl", ["--request-timeout=30s", "-n", this.namespace, ...args]);
  }
  private async deployment(target: string): Promise<Deployment> {
    return JSON.parse(await this.kubectl(["get", "deployment", target, "-o", "json"])) as Deployment;
  }
  async snapshot(): Promise<Snapshot> {
    const services: Service[] = [];
    for (const name of this.targets) {
      const deployment = await this.deployment(name);
      const status = deployment.status ?? {};
      const replicas = deployment.spec.replicas ?? 1;
      const ready = replicas > 0 &&
        (status.observedGeneration ?? 0) >= deployment.metadata.generation &&
        (status.updatedReplicas ?? 0) >= replicas &&
        (status.availableReplicas ?? 0) >= replicas &&
        (status.readyReplicas ?? 0) >= replicas;
      const conditions = status.conditions?.map(c => `${c.type}: ${c.reason} (${c.status})`) ?? [];
      let output: string;
      try { output = await this.kubectl(["logs", `deployment/${name}`, "--all-containers=true", "--tail=70"]); }
      catch (error) { output = `Logs unavailable: ${(error as Error).message}`; }
      services.push({
        name, status: ready ? "healthy" : (status.readyReplicas ?? 0) === 0 ? "down" : "degraded",
        restarts: 0, cpuPercent: null, memoryPercent: null, errorRate: null, latencyMs: null,
        dependencies: [], logs: [...conditions, ...logs(output)].slice(-80),
      });
    }
    return { observedAt: new Date().toISOString(), source: `${this.name}:${this.namespace}`, services };
  }
  async execute(action: Action, target: string): Promise<string> {
    if (!this.targets.includes(target)) throw new Error("Kubernetes target not allowlisted.");
    if (action === "inspect") {
      return this.kubectl(["describe", "deployment", target]);
    }
    if (action === "escalate") return "Escalated to operator.";
    let result: string;
    if (action === "restart") {
      result = await this.kubectl(["rollout", "restart", `deployment/${target}`]);
    } else if (action === "rollback") {
      result = await this.kubectl(["rollout", "undo", `deployment/${target}`]);
    } else if (action === "scale") {
      const deployment = await this.deployment(target);
      const current = deployment.spec.replicas ?? 1;
      if (current >= this.maxReplicas) throw new Error("Replica safety cap reached; refusing to scale.");
      result = await this.kubectl(["scale", `deployment/${target}`, `--replicas=${current + 1}`]);
    } else {
      throw new Error(`Unsupported action ${action}.`);
    }
    // A ready old ReplicaSet must not be mistaken for a successful new rollout.
    result += await this.kubectl(["rollout", "status", `deployment/${target}`, "--timeout=45s"]);
    return result;
  }
}

export class SnapshotFileAdapter implements RuntimeAdapter {
  readonly name = "snapshot-file (observe-only)";
  readonly supported = Actions;
  private constructor(private readonly state: Snapshot, readonly targets: readonly string[]) {}
  static async open(path: string, targets: readonly string[]): Promise<SnapshotFileAdapter> {
    validTargets(targets);
    const state = SnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const selected = state.services.filter(s => targets.includes(s.name));
    if (selected.length !== targets.length) throw new Error("Snapshot is missing allowlisted targets.");
    return new SnapshotFileAdapter({
      ...state, services: selected.map(s => ({ ...s, logs: s.logs.map(redact) })),
    }, targets);
  }
  async snapshot(): Promise<Snapshot> { return structuredClone(this.state); }
  async execute(action: Action, target: string): Promise<string> {
    if (!this.targets.includes(target)) throw new Error("Snapshot target not allowlisted.");
    if (action === "inspect") return this.state.services.find(s => s.name === target)!.logs.join("\n");
    throw new Error("Static snapshots cannot execute mutations or confirm live recovery.");
  }
}
export const TopologySchema = z.record(z.string(), z.array(z.string().min(1).max(120)).max(50));
export function withTopology(adapter: RuntimeAdapter, topology: unknown): RuntimeAdapter {
  const graph = TopologySchema.parse(topology);
  return {
    name: adapter.name, targets: adapter.targets, supported: adapter.supported,
    snapshot: async () => {
      const state = await adapter.snapshot();
      return { ...state, services: state.services.map(s => ({
        ...s, dependencies: graph[s.name] ?? s.dependencies,
      })) };
    },
    execute: (action, target) => adapter.execute(action, target),
    close: adapter.close ? () => adapter.close!() : undefined,
  };
}