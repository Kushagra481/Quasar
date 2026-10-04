# Quasar

Runnable agentic microservice debugging framework: Gemini diagnosis, LangGraph orchestration, offline Q-learning and bounded Docker/Kubernetes recovery.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm quasar demo --fault crash --offline --apply` — run the safe local HTTP fault harness
- `pnpm quasar demo --fault crash --apply` — run the harness with real Gemini diagnosis
- `pnpm quasar dataset` / `pnpm quasar train --dataset examples/synthetic-transitions.jsonl` — generate explicitly synthetic data and train a policy
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required for LLM mode: `GEMINI_API_KEY`. Optional model selection: `QUASAR_GEMINI_MODEL`.
- Offline CLI and API demos do not need model credentials.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/quasar/src` — framework modules; see README for module map
- `scripts/src/quasar.ts` — CLI
- `lib/api-spec/openapi.yaml` — API contract (regenerate after changes)
- `artifacts/api-server/src/routes/quasar.ts` — local-demo API; no live adapter exposure
- `examples` — synthetic telemetry, topology and transition fixtures

## Architecture decisions

- CLI-first because the user requested implementation of the framework, not a dashboard.
- Live tools are intentionally CLI-only. **Why:** an unauthenticated demo API must not expose cluster mutations or paid model calls.
- A versioned tabular policy is trained offline. **Why:** this is an inspectable baseline without unsupported deep-RL or online-production-learning claims.
- LO2 results are not reproduced or seeded. **Why:** no actual LO2 dataset or evaluation protocol was provided.

## Product

Detect unhealthy workloads; diagnose using Gemini or explicit offline rules; select actions using a trained Q-policy; gate mutations; verify health; persist audit trails; train/evaluate normalized JSONL transitions; monitor allowlisted workloads.

## User preferences

Use Gemini with the user's own API key, not OpenAI.

## Gotchas

- Do not run Docker or install a Docker daemon here. Live Docker/kubectl adapters require an operator-configured external host; use the HTTP harness locally.
- Never treat synthetic fixtures or in-sample evaluator output as LO2 results or as the claimed 18%/27% improvements.
- `.local/quasar` contains private runtime data; do not commit it.
- Do not turn on live mutation by default or expose the CLI audit store through the public demo API.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
