// Runs the CAD tasks against local models through Ollama, using the app's own
// agent loop, tools and system prompt. Results go to eval/results/.
//
//   EVAL_MODELS=qwen3.5:4b,bonsai-2:9b EVAL_TASKS=cube,plate-hole npx vitest run -c eval/vitest.config.ts
//
// Optional: OLLAMA_URL (default http://127.0.0.1:11434), EVAL_THINKING=on (model
// reasons before each step), EVAL_TASK_MINUTES (default 25).

import fs from "node:fs";
import path from "node:path";
import { beforeAll, test } from "vitest";
import { Agent, type AgentSettings, type AgentUI } from "../src/ai/agent";
import { initKernel } from "../src/geom/kernel";
import { Doc } from "../src/model/doc";
import { TASKS, type Check } from "./tasks";

const MODELS = (process.env.EVAL_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = (process.env.EVAL_TASKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TASK_TIMEOUT_MS = Number(process.env.EVAL_TASK_MINUTES ?? 25) * 60_000;

interface Result {
  model: string;
  task: string;
  seconds: number;
  toolCalls: number;
  toolErrors: number;
  outputTokens: number;
  inputTokens: number;
  checks: Check[];
  score: number;
  errors: string[];
  transcript: string[];
}

beforeAll(() => initKernel());

function recorder() {
  const r = { toolCalls: 0, toolErrors: 0, outputTokens: 0, inputTokens: 0, errors: [] as string[], transcript: [] as string[] };
  let text = "";
  const ui: AgentUI = {
    busy: () => {},
    text: (delta, start) => {
      if (start && text) r.transcript.push(`assistant: ${text}`), (text = "");
      text += delta;
    },
    progress: (note) => r.transcript.push(`progress: ${note.slice(0, 300)}`),
    toolPending: () => {},
    toolDone: (summary, isError) => {
      r.toolCalls++;
      if (isError) r.toolErrors++;
      r.transcript.push(`${isError ? "TOOL ERROR" : "tool"}: ${summary}`);
    },
    interjectionDelivered: () => {},
    error: (m) => r.errors.push(m),
    usage: (i, o) => ((r.inputTokens += i), (r.outputTokens += o)),
  };
  return { r, ui, flush: () => text && r.transcript.push(`assistant: ${text}`) };
}

async function runTask(model: string, taskId: string): Promise<Result> {
  const task = TASKS.find((t) => t.id === taskId)!;
  const doc = new Doc();
  const { r, ui, flush } = recorder();
  const settings: AgentSettings = {
    provider: "local",
    apiKey: "",
    model: "",
    effort: "medium",
    localURL: URL,
    localModel: model,
    localThinking: process.env.EVAL_THINKING === "on",
  };
  const agent = new Agent({ doc, snapshot: () => "", select: () => {} }, ui, () => settings, (...a) => fetch(...a));
  const start = Date.now();
  agent.send(task.prompt);
  while (agent.isRunning && Date.now() - start < TASK_TIMEOUT_MS) await new Promise((res) => setTimeout(res, 500));
  if (agent.isRunning) {
    agent.stop();
    r.errors.push(`timed out after ${TASK_TIMEOUT_MS / 60000} min`);
    while (agent.isRunning) await new Promise((res) => setTimeout(res, 200));
  }
  flush();
  const checks = task.check(doc);
  return {
    model,
    task: taskId,
    seconds: Math.round((Date.now() - start) / 1000),
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    outputTokens: r.outputTokens,
    inputTokens: r.inputTokens,
    checks,
    score: checks.filter((c) => c.pass).length / checks.length,
    errors: r.errors,
    transcript: r.transcript,
  };
}

const outDir = path.resolve(import.meta.dirname, "results");

test.skipIf(MODELS.length === 0)("local models build CAD tasks", async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const ids = TASKS.map((t) => t.id).filter((id) => !ONLY.length || ONLY.includes(id));
  for (const model of MODELS) {
    for (const id of ids) {
      const res = await runTask(model, id);
      const file = path.join(outDir, `${model.replace(/[^a-z0-9.]+/gi, "_")}__${id}.json`);
      fs.writeFileSync(file, JSON.stringify(res, null, 2));
      const fails = res.checks.filter((c) => !c.pass).map((c) => `${c.label}: ${c.detail}`);
      console.log(
        `${model.padEnd(16)} ${id.padEnd(11)} ${(res.score * 100).toFixed(0).padStart(3)}%  ${String(res.seconds).padStart(5)}s  ` +
          `${res.toolCalls} calls (${res.toolErrors} failed)  ${res.inputTokens} in / ${res.outputTokens} out tok` +
          (fails.length ? `\n    ✗ ${fails.join("\n    ✗ ")}` : "") +
          (res.errors.length ? `\n    ! ${res.errors.join("; ")}` : ""),
      );
    }
  }
});
