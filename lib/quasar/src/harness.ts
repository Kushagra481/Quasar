import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Actions, healthy } from "./contracts";
import type { Action, Fault, RuntimeAdapter, Snapshot } from "./contracts";
import type { Transition } from "./policy";

// These faults are deliberately synthetic. The harness still sends real HTTP traffic
// through a gateway and worker, and measures responses rather than mocking health results.
export class LocalHarness implements RuntimeAdapter {
  readonly name = "local-http-fault-harness (synthetic faults)";
  readonly targets = ["gateway", "worker"] as const;
  readonly supported = Actions;
  private fault: Fault | null;
  private attempts = 0;
  private restarts = 0;
  private replicas = 1;
  private logs: string[] = [];
  private worker!: Server;
  private gateway!: Server;
  private workerUrl = "";
  private gatewayUrl = "";
  private constructor(fault: Fault) { this.fault = fault; }
  static async start(fault: Fault): Promise<LocalHarness> {
    const adapter = new LocalHarness(fault);
    try {
      adapter.worker = createServer((_req, res) => {
        const message = adapter.fault === "crash" ? "fatal crash: worker handler unavailable"
          : adapter.fault === "resource" ? "resource pressure: queue saturation"
          : adapter.fault === "regression" ? "bad deployment: version mismatch regression"
          : adapter.fault === "dependency" ? "dependency unavailable: upstream database"
          : "request completed successfully";
        adapter.logs.push(`${new Date().toISOString()} ${message}`);
        adapter.logs = adapter.logs.slice(-80);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = adapter.fault ? 503 : 200;
        res.end(JSON.stringify({ ok: !adapter.fault, message, replicas: adapter.replicas }));
      });
      adapter.workerUrl = await listen(adapter.worker);
      adapter.gateway = createServer(async (_req, res) => {
        try {
          const upstream = await fetch(adapter.workerUrl, { signal: AbortSignal.timeout(2000) });
          res.statusCode = upstream.status;
          res.end(await upstream.text());
        } catch {
          res.statusCode = 502;
          res.end("worker unavailable");
        }
      });
      adapter.gatewayUrl = await listen(adapter.gateway);
      return adapter;
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }
  async snapshot(): Promise<Snapshot> {
    const started = performance.now();
    const response = await fetch(this.gatewayUrl, { signal: AbortSignal.timeout(3000) });
    const latencyMs = performance.now() - started;
    this.attempts++;
    const good = response.status === 200;
    return {
      observedAt: new Date().toISOString(), source: this.name,
      services: [
        {
          name: "worker", status: good ? "healthy" : this.fault === "crash" ? "down" : "degraded",
          restarts: this.restarts, cpuPercent: this.fault === "resource" ? 97 : 20,
          memoryPercent: this.fault === "resource" ? 94 : 30, errorRate: good ? 0 : 1,
          latencyMs, dependencies: [], logs: [...this.logs],
        },
        {
          name: "gateway", status: good ? "healthy" : "degraded",
          restarts: 0, cpuPercent: 10, memoryPercent: 15, errorRate: good ? 0 : 1,
          latencyMs, dependencies: ["worker"],
          logs: [`Observed upstream HTTP ${response.status} across ${this.attempts} probes.`],
        },
      ],
    };
  }
  async execute(action: Action, target: string): Promise<string> {
    if (!this.targets.includes(target as "worker" | "gateway")) throw new Error("Target not allowlisted.");
    if (action === "inspect") return this.logs.slice(-10).join("\n");
    if (action === "escalate") return "Escalated.";
    if (target !== "worker") return "Gateway operation cannot fix a worker fault.";
    if (action === "restart") {
      this.restarts++;
      if (this.fault === "crash") this.fault = null;
    } else if (action === "scale") {
      this.replicas = Math.min(this.replicas + 1, 3);
      if (this.fault === "resource") this.fault = null;
    } else if (action === "rollback" && this.fault === "regression") {
      this.fault = null;
    }
    return `Local ${action} applied to worker; HTTP verification will determine recovery.`;
  }
  async close(): Promise<void> {
    await Promise.all([this.gateway, this.worker].filter(Boolean).map(server =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
      })));
  }
}
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

// A finite transition model for offline Q-learning. This is not LO2.
export function syntheticTransitions(): Transition[] {
  const rows: Transition[] = [];
  const now = "2026-01-01T00:00:00.000Z";
  for (const fault of ["crash", "resource", "regression", "dependency"] as const) {
    const state: Snapshot = {
      observedAt: now, source: "synthetic-transition-model",
      services: [{
        name: "worker", status: fault === "crash" ? "down" : "degraded", restarts: 0,
        cpuPercent: fault === "resource" ? 97 : 20, memoryPercent: 40, errorRate: 1,
        latencyMs: 100, dependencies: [],
        logs: [fault === "regression" ? "bad deployment regression"
          : fault === "resource" ? "resource pressure" : fault === "dependency" ? "dependency unavailable" : "fatal crash"],
      }],
    };
    for (const action of Actions) {
      const recovered = (fault === "crash" && action === "restart") ||
        (fault === "resource" && action === "scale") || (fault === "regression" && action === "rollback");
      const nextState = structuredClone(state);
      if (recovered) {
        nextState.services[0]!.status = "healthy";
        nextState.services[0]!.errorRate = 0;
        nextState.services[0]!.logs = ["request successful"];
      }
      rows.push({
        state, cause: fault, action, nextState, nextCause: recovered ? "healthy" : fault,
        terminal: recovered || action === "escalate",
        reward: recovered ? 10 : action === "escalate" ? (fault === "dependency" ? 1 : -3)
          : action === "inspect" ? -0.5 : -5,
      });
    }
  }
  if (!rows.some(row => healthy(row.nextState))) throw new Error("Synthetic transition generation failed.");
  return rows;
}