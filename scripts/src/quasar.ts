import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  DockerAdapter, FaultSchema, GeminiReasoner, HeuristicReasoner, KubernetesAdapter,
  LocalHarness, QPolicy, RunStore, evaluateTransitions, loadPolicy, loadTransitions,
  SnapshotFileAdapter, healthy, redact, runAgent, syntheticTransitions, train, withTopology, writeJson,
} from "@workspace/quasar";
import type { RuntimeAdapter } from "@workspace/quasar";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    offline: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "allow-rollback": { type: "boolean", default: false },
    fault: { type: "string", default: "crash" },
    adapter: { type: "string", default: "docker" },
    targets: { type: "string" },
    namespace: { type: "string" },
    "max-replicas": { type: "string", default: "5" },
    "max-steps": { type: "string", default: "6" },
    "max-mutations": { type: "string", default: "2" },
    dataset: { type: "string" },
    policy: { type: "string" },
    epochs: { type: "string", default: "200" },
    seed: { type: "string", default: "42" },
    out: { type: "string" },
    id: { type: "string" },
    input: { type: "string" },
    topology: { type: "string" },
    "poll-seconds": { type: "string", default: "15" },
    "max-incidents": { type: "string", default: "5" },
    "z-threshold": { type: "string", default: "3.5" },
    "fraction-threshold": { type: "string", default: "0.1" },
  },
});
// pnpm executes scripts from scripts/, so anchor all default data to the repository.
const root = resolve(import.meta.dirname, "../..");
const path = (value: string) => resolve(root, value);
const policyPath = path(values.policy ?? ".local/quasar/policy.json");
const store = new RunStore(path(".local/quasar/runs"));
const integer = (value: string | undefined, name: string, min: number, max: number) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}.`);
  return n;
};

async function main(): Promise<void> {
  const operation = positionals[0] ?? "help";
  if (operation === "dataset") {
    const target = path(values.out ?? "examples/synthetic-transitions.jsonl");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, syntheticTransitions().map(row => JSON.stringify(row)).join("\n") + "\n");
    process.stdout.write(`Wrote synthetic (NOT LO2) transitions to ${target}\n`);
    return;
  }
  if (operation === "train") {
    if (!values.dataset) throw new Error("train requires --dataset; synthetic and LO2 data must never be conflated.");
    const transitions = await loadTransitions(path(values.dataset));
    const model = train(transitions, values.dataset,
      integer(values.epochs, "epochs", 1, 10000), integer(values.seed, "seed", 0, 2147483647));
    await writeJson(path(values.out ?? ".local/quasar/policy.json"), model);
    process.stdout.write(JSON.stringify({ policy: model.name, transitions: transitions.length,
      updates: model.updates, dataset: model.dataset }, null, 2) + "\n");
    return;
  }
  if (operation === "evaluate") {
    if (!values.dataset) throw new Error("evaluate requires --dataset (prefer held-out transitions).");
    const report = evaluateTransitions(await loadPolicy(policyPath), await loadTransitions(path(values.dataset)));
    report.dataset = values.dataset;
    await writeJson(path(values.out ?? ".local/quasar/evaluation.json"), report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  if (operation === "lo2-benchmark") {
    if (!values.dataset) throw new Error("lo2-benchmark requires --dataset with an official LO2v2 per-test JSON metrics archive or extracted directory.");
    const result = spawnSync("python3", [
      resolve(import.meta.dirname, "lo2_benchmark.py"),
      "--dataset", path(values.dataset),
      "--z-threshold", values["z-threshold"] ?? "3.5",
      "--fraction-threshold", values["fraction-threshold"] ?? "0.1",
      ...(values.out ? ["--out", path(values.out)] : []),
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(redact(result.stderr));
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  if (operation === "runs") {
    process.stdout.write(JSON.stringify(values.id ? await store.get(values.id) : await store.list(), null, 2) + "\n");
    return;
  }
  if (operation === "demo" || operation === "run" || operation === "monitor") {
    let adapter: RuntimeAdapter;
    if (operation === "demo") {
      adapter = await LocalHarness.start(FaultSchema.parse(values.fault));
    } else {
      const targets = values.targets?.split(",").filter(Boolean);
      if (!targets?.length) throw new Error("Live run requires an explicit --targets allowlist.");
      if (values.adapter === "docker") adapter = new DockerAdapter(targets);
      else if (values.adapter === "kubernetes") {
        if (!values.namespace) throw new Error("Kubernetes requires --namespace; no default namespace is assumed.");
        adapter = new KubernetesAdapter(targets, values.namespace,
          integer(values["max-replicas"], "max-replicas", 1, 10));
      } else if (values.adapter === "snapshot") {
        if (!values.input || values.apply || operation === "monitor") {
          throw new Error("snapshot requires --input and only supports one-shot observe-only runs (no --apply).");
        }
        adapter = await SnapshotFileAdapter.open(path(values.input), targets);
      } else throw new Error("adapter must be docker, kubernetes, or snapshot.");
    }
    try {
      if (values.topology) {
        adapter = withTopology(adapter, JSON.parse(await readFile(path(values.topology), "utf8")));
      }
      const model = operation === "demo" && !values.policy
        ? train(syntheticTransitions(), "synthetic transition model (NOT LO2)")
        : await loadPolicy(policyPath);
      const reasoner = values.offline ? new HeuristicReasoner() : new GeminiReasoner();
      const safety = {
        apply: values.apply,
        allowRollback: values["allow-rollback"],
        maxSteps: integer(values["max-steps"], "max-steps", 1, 20),
        maxMutations: integer(values["max-mutations"], "max-mutations", 0, 5),
        verificationDelayMs: operation === "demo" ? 10 : 3000,
      };
      const incidents = operation === "monitor"
        ? integer(values["max-incidents"], "max-incidents", 1, 20) : 1;
      const pollMs = integer(values["poll-seconds"], "poll-seconds", 5, 300) * 1000;
      let stopped = false;
      const stop = () => { stopped = true; };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        for (let i = 0; i < incidents && !stopped;) {
          if (operation === "monitor" && healthy(await adapter.snapshot())) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            continue;
          }
          const result = await runAgent(adapter, reasoner, new QPolicy(model), safety);
          await store.save(result);
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          i++;
          if (result.status === "failed") process.exitCode = 1;
          // Never keep mutating the same unresolved incident in an unattended loop.
          if (operation !== "monitor" || result.status !== "resolved") break;
          if (i < incidents) await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    } finally { await adapter.close?.(); }
    return;
  }
  process.stdout.write(`
Quasar: Gemini + LangGraph + offline Q-learning

pnpm quasar demo --fault crash --offline --apply
pnpm quasar demo --fault regression --apply --allow-rollback
pnpm quasar dataset
pnpm quasar train --dataset examples/synthetic-transitions.jsonl
pnpm quasar evaluate --dataset examples/synthetic-transitions.jsonl
pnpm quasar lo2-benchmark --dataset /path/to/light-oauth2-metrics.zip
pnpm quasar runs [--id UUID]
pnpm quasar run --adapter docker --targets worker --policy .local/quasar/policy.json
pnpm quasar run --adapter kubernetes --namespace staging --targets worker --apply
pnpm quasar run --adapter snapshot --input examples/incident.json --targets worker
pnpm quasar monitor --adapter kubernetes --namespace staging --targets worker --max-incidents 5

Default diagnosis: Gemini via GEMINI_API_KEY. --offline is explicitly non-LLM.
Default execution: OBSERVE ONLY. --apply permits bounded, allowlisted mutations.
Rollback needs BOTH --apply and --allow-rollback. Live tools require installed
Docker/kubectl and operator-configured infrastructure credentials on your host.
Synthetic demos are not LO2 evaluation or evidence of the supplied 18%/27% claims.
`);
}
main().catch(error => {
  process.stderr.write(redact(error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});