import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunResult } from "./contracts";
import { PolicySchema, TransitionSchema } from "./policy";
import type { PolicyModel, Transition } from "./policy";

export async function writeJson(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  const directory = resolve(target, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, target);
}
export class RunStore {
  constructor(private readonly directory = process.env["QUASAR_DATA_DIR"] ?? ".local/quasar/runs") {}
  async save(run: RunResult): Promise<void> {
    await writeJson(join(this.directory, `${run.id}.json`), run);
  }
  async get(id: string): Promise<RunResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error("Invalid run id.");
    return JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as RunResult;
  }
  async list(): Promise<RunResult[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter(n => /^[0-9a-f-]+\.json$/.test(n));
    const runs = await Promise.all(names.map(name => this.get(name.slice(0, -5))));
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
  }
}
export async function loadPolicy(path: string): Promise<PolicyModel> {
  return PolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
}
export async function loadTransitions(path: string): Promise<Transition[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter(line => line.trim()).map((line, index) => {
    try { return TransitionSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid transition at line ${index + 1}. See README dataset schema.`); }
  });
}