import { Router, type IRouter } from "express";
import { resolve } from "node:path";
import { RunQuasarDemoBody } from "@workspace/api-zod";
import {
  Actions, HeuristicReasoner, LocalHarness, QPolicy, RunStore,
  runAgent, syntheticTransitions, train,
} from "@workspace/quasar";

const router: IRouter = Router();
// Never expose live CLI run histories, infrastructure credentials, or paid model calls here.
const store = new RunStore(resolve(process.cwd(), "../../.local/quasar/api-runs"));
const policy = new QPolicy(train(syntheticTransitions(), "synthetic transition model (NOT LO2)"));
let activeRuns = 0;
router.get("/quasar/status", (_req, res) => {
  res.json({
    framework: "Quasar", version: "0.1.0", graph: "LangGraph",
    diagnosisProvider: "Gemini (CLI only)", policy: "offline tabular Q-learning",
    actions: Actions, apiMode: "local synthetic HTTP harness only",
    defaults: { apply: false, maxMutations: 2, maxSteps: 6, allowRollback: false },
    liveAdapters: ["Docker CLI", "Kubernetes CLI"],
    liveAdapterAccess: "Explicitly allowlisted CLI targets; never available through this API",
    datasetStatus: "LO2v2: one public example run tested for error-task labels; no remediation trajectories",
    commands: ["pnpm quasar demo --fault crash --offline --apply", "pnpm quasar demo --fault crash --apply"],
  });
});
router.post("/quasar/demo", async (req, res) => {
  const parsed = RunQuasarDemoBody.safeParse(req.body);
  if (!parsed.success || Object.keys(req.body ?? {}).some(k => !["fault", "apply", "allowRollback"].includes(k))) {
    res.status(400).json({ error: "Expected fault plus optional apply and allowRollback booleans." });
    return;
  }
  if (activeRuns >= 2) {
    res.status(429).json({ error: "Two demo runs are already active; retry later." });
    return;
  }
  activeRuns++;
  let harness: LocalHarness | undefined;
  try {
    harness = await LocalHarness.start(parsed.data.fault);
    const result = await runAgent(harness, new HeuristicReasoner(), policy, {
      apply: parsed.data.apply, allowRollback: parsed.data.allowRollback, verificationDelayMs: 10,
    });
    await store.save(result);
    res.json(result);
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.name : "UnknownError" }, "Local demo failed");
    res.status(500).json({ error: "Local demo could not complete." });
  } finally {
    activeRuns--;
    await harness?.close();
  }
});
router.get("/quasar/runs", async (req, res) => {
  try { res.json(await store.list()); }
  catch {
    req.log.error("Could not load local demo run history");
    res.status(500).json({ error: "Run history unavailable." });
  }
});
router.get("/quasar/runs/:id", async (req, res) => {
  try { res.json(await store.get(String(req.params.id))); }
  catch { res.status(404).json({ error: "Run not found." }); }
});
export default router;