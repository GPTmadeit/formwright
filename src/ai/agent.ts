import Anthropic from "@anthropic-ai/sdk";
import type { Doc } from "../model/doc";
import { TOOLS, describeScene, runTool, type ToolHost } from "./tools";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Provider = "anthropic" | "local";

export interface AgentSettings {
  /** "local" talks to an Ollama server (or anything serving its Anthropic-compatible API). */
  provider: Provider;
  apiKey: string;
  model: string;
  effort: Effort;
  localURL: string;
  localModel: string;
  /** Optional API endpoint override (a proxy, or the test server). */
  baseURL?: string;
}

/** What the chat panel renders. */
export interface AgentUI {
  busy(on: boolean): void;
  /** Streaming reply text; `blockStart` marks a new text block. */
  text(delta: string, blockStart: boolean): void;
  /** Short progress note the model writes between steps. */
  progress(note: string): void;
  /** A tool call has begun streaming (before it runs). */
  toolPending(name: string): void;
  /** A tool call ran. `touched` are shape ids it affected. */
  toolDone(summary: string, isError: boolean, touched: string[]): void;
  /** The user's queued message was delivered mid-turn. */
  interjectionDelivered(text: string): void;
  error(message: string): void;
  usage(inputTokens: number, outputTokens: number): void;
}

const SYSTEM = `You are the modelling assistant inside Formwright, a friendly open-source CAD app. The user watches the 3D viewport while you build, one tool call at a time, so they can see the object take shape and interrupt you.

Coordinate system and conventions:
- Units are millimetres. Z is up. The workplane is z = 0, and finished objects should rest on it (lowest point at z = 0) unless the user wants otherwise.
- A shape's position is the centre of its bounding box. A 40 mm tall box sitting on the workplane has position z = 20.
- Rotations are degrees about the shape's centre, applied X, then Y, then Z. Cylinders, cones and tubes run along Z before rotation; rotate [90, 0, 0] to lay one along Y, [0, 90, 0] along X.
- Wedge: full height at the back (+Y), sloping down to the front (-Y).
- Polygon: an [x, y] outline extruded up by height, then centred on its position. Revolve: a [radius, z] profile spun around Z, then centred.
- To cut, create a shape with hole = true and group it with the solids it should cut. Holes do nothing until grouped. Make holes slightly longer than what they pass through (about 1 mm extra each side) so the cut is clean.
- Groups merge solids. A group can be moved, rotated, duplicated and nested. Its colour is its first solid child's colour unless set.
- Name shapes for what they are ("Handle", "Screw hole"), and give parts sensible colours.

How to work:
- Before your first tool call, say in one short sentence what you're going to build. Then build it in a sensible order, roughly one part per call, so the user can follow along. Narrate briefly as you go; keep it short.
- Realistic proportions matter. If the user gives no sizes, choose practical, printable ones and say what you chose.
- Each user message starts with the current scene. The user can edit the scene by hand at any time, and their edits win: always work from the latest state you've been given, and don't undo their changes.
- If the user interjects while you're working, adjust the plan right away.
- After cutting holes or finishing a multi-part object, call view_snapshot once to check it looks right, and fix anything wrong.
- Finish with one or two sentences on what you made and what they could tweak. If a request is ambiguous in a way that changes the design, ask one short question instead of guessing.`;

const LOCAL_NOTE = "\n\nThe view_snapshot tool is not available in this session; check your work with get_scene and the returned bounds instead.";

const LOCAL_TOOLS: Anthropic.Tool[] = TOOLS.filter((t) => t.name !== "view_snapshot").map(({ name, description, input_schema }) => ({
  name,
  description,
  input_schema: input_schema as Anthropic.Tool.InputSchema,
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Agent {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private queue: string[] = [];
  private running = false;
  private stopRequested = false;
  private stream: { abort(): void } | null = null;
  /** Revision of the doc the model last saw. */
  private seenRevision = -1;
  private userEditedDuringRun = false;

  constructor(
    private host: ToolHost & { doc: Doc },
    private ui: AgentUI,
    private settings: () => AgentSettings,
    /** fetch for local servers; the desktop app routes these through Rust to avoid CORS. */
    private localFetch: typeof fetch = (...a) => fetch(...a),
  ) {
    host.doc.onChange((e) => {
      if (this.running && e.source !== "ai") this.userEditedDuringRun = true;
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Clears the conversation (the scene is left alone). */
  reset(): void {
    this.stop();
    this.messages = [];
    this.queue = [];
    this.seenRevision = -1;
  }

  /** Sends a message, or queues it as an interjection if a turn is running. */
  send(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.running) {
      this.queue.push(t);
      return;
    }
    void this.run(t);
  }

  stop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.stream?.abort();
  }

  private sceneBlock(): Anthropic.Beta.BetaTextBlockParam {
    this.seenRevision = this.host.doc.revision;
    return { type: "text", text: `<scene>\n${describeScene(this.host.doc)}\n</scene>` };
  }

  private async run(first: string): Promise<void> {
    const s = this.settings();
    const local = s.provider === "local";
    if (!local && !s.apiKey) {
      this.ui.error("Add your Anthropic API key in Settings, or switch to a local model.");
      return;
    }
    const client = local
      ? // Ollama ignores the key but the SDK requires one.
        new Anthropic({ apiKey: "ollama", baseURL: s.localURL.replace(/\/+$/, ""), fetch: this.localFetch, dangerouslyAllowBrowser: true })
      : new Anthropic({ apiKey: s.apiKey, baseURL: s.baseURL || undefined, dangerouslyAllowBrowser: true });
    this.running = true;
    this.stopRequested = false;
    this.userEditedDuringRun = false;
    this.ui.busy(true);

    this.messages.push({ role: "user", content: [this.sceneBlock(), { type: "text", text: first }] });

    let jsonRetries = 0;
    try {
      while (!this.stopRequested) {
        // Haiku has no server-side fallback; the parameter is rejected there.
        const fallback = !s.model.includes("haiku");
        const stream = local
          ? // Local servers get the plain Messages API: no betas, caching or
            // fallbacks, and no snapshot tool (small models rarely handle images).
            (client.messages.stream({
              model: s.localModel,
              max_tokens: 8192,
              system: SYSTEM + LOCAL_NOTE,
              tools: LOCAL_TOOLS,
              messages: this.messages as Anthropic.MessageParam[],
            }) as unknown as ReturnType<typeof client.beta.messages.stream>)
          : client.beta.messages.stream({
          model: s.model,
          max_tokens: 32000,
          system: SYSTEM,
          tools: TOOLS,
          messages: this.messages,
          thinking: { type: "adaptive", display: "updates" },
          output_config: { effort: s.effort },
          cache_control: { type: "ephemeral" },
          ...(fallback ? { fallbacks: "default" as const } : {}),
          betas: ["thinking-display-updates-2026-08-18", ...(fallback ? ["server-side-fallback-2026-07-01"] : [])],
        });
        this.stream = stream;

        let message: Anthropic.Beta.BetaMessage;
        try {
          let progress = "";
          for await (const ev of stream) {
            if (ev.type === "content_block_start") {
              if (ev.content_block.type === "text") this.ui.text("", true);
              if (ev.content_block.type === "tool_use") this.ui.toolPending(ev.content_block.name);
              progress = "";
            } else if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") this.ui.text(ev.delta.text, false);
              else if (ev.delta.type === "thinking_delta") progress += ev.delta.thinking;
            } else if (ev.type === "content_block_stop" && progress.trim()) {
              this.ui.progress(progress.trim());
              progress = "";
            }
          }
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (this.stopRequested || err instanceof Anthropic.APIUserAbortError) break;
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          // A tool input that could not be parsed at all: re-issue the turn.
          continue;
        } finally {
          this.stream = null;
        }

        this.ui.usage(message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0), message.usage.output_tokens);

        if (message.stop_reason === "refusal") {
          this.ui.error("The model declined this request.");
          break;
        }
        if (message.stop_reason === "pause_turn") {
          this.messages.push({ role: "assistant", content: message.content });
          continue;
        }

        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length && message.stop_reason === "max_tokens") {
          this.ui.error("The reply was cut off mid-step. Try asking for a smaller piece at a time.");
          break;
        }
        this.messages.push({ role: "assistant", content: message.content });
        if (toolUses.length === 0) {
          // The turn ended; anything typed meanwhile starts the next one.
          if (this.queue.length && !this.stopRequested) {
            const next = this.queue.splice(0);
            next.forEach((t) => this.ui.interjectionDelivered(t));
            this.messages.push({ role: "user", content: [this.sceneBlock(), { type: "text", text: next.join("\n\n") }] });
            continue;
          }
          break;
        }

        const results: (Anthropic.Beta.BetaToolResultBlockParam | Anthropic.Beta.BetaTextBlockParam)[] = [];
        for (const tu of toolUses) {
          if (this.stopRequested) {
            results.push({ type: "tool_result", tool_use_id: tu.id, content: "Not run: the user pressed Stop.", is_error: true });
            continue;
          }
          try {
            const out = runTool(this.host, tu.name, tu.input);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, is_error: out.isError || undefined });
            this.ui.toolDone(out.summary, out.isError, out.touched);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${msg}`, is_error: true });
            this.ui.toolDone(`${tu.name} failed: ${msg}`, true, []);
          }
          // Give the viewport time to animate each step so the build is watchable.
          if (tu.name !== "get_scene" && tu.name !== "view_snapshot") await sleep(380);
        }
        this.seenRevision = this.host.doc.revision;

        if (this.userEditedDuringRun) {
          this.userEditedDuringRun = false;
          results.push({ type: "text", text: `The user edited the scene by hand while you were working. Current state:\n${this.sceneBlock().text}` });
        }
        if (this.queue.length) {
          const said = this.queue.splice(0);
          said.forEach((t) => this.ui.interjectionDelivered(t));
          results.push({ type: "text", text: `The user interjects while you work:\n${said.join("\n\n")}` });
        }
        this.messages.push({ role: "user", content: results });
      }
    } catch (err) {
      this.ui.error(describeError(err));
    } finally {
      if (this.stopRequested) this.ui.progress("Stopped. Everything built so far is kept.");
      this.running = false;
      this.stream = null;
      this.ui.busy(false);
      // Typed while stopping or while the last request failed: deliver it now.
      if (this.queue.length) void this.run(this.queue.splice(0).join("\n\n"));
    }
  }

  /** True when the model hasn't seen the latest scene. */
  get sceneIsStale(): boolean {
    return this.seenRevision !== this.host.doc.revision;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key can't use that model.";
  if (err instanceof Anthropic.NotFoundError) return "Model not found. Check the model name in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the model server. Check your connection, or that Ollama is running for local models.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
