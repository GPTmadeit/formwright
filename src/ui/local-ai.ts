import { LOCAL_MODELS, recommendedTier, type LocalModelOption } from "../ai/models";
import { localAI, type LocalAiProgress, type LocalAiStatus } from "../platform";

const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;

/**
 * The local-model section of Settings: shows the engine and the three model
 * tiers, and installs any of them with one click (engine included).
 */
export class LocalAiPanel {
  private status: LocalAiStatus | null = null;
  private busy: { model: string; progress: LocalAiProgress | null } | null = null;
  private error = "";

  constructor(
    private statusEl: HTMLElement,
    private tiersEl: HTMLElement,
    private current: () => { provider: string; localModel: string },
    /** Called when a model is chosen (after installing it, if needed). */
    private choose: (model: string, url: string) => Promise<void>,
  ) {}

  async refresh(): Promise<void> {
    if (!localAI.available) return;
    try {
      this.status = await localAI.status();
    } catch (err) {
      this.status = null;
      this.error = String(err);
    }
    this.render();
  }

  private has(model: string): boolean {
    return !!this.status?.models.some((m) => m.name === model || m.name === `${model}:latest`);
  }

  private render(): void {
    const s = this.status;
    this.statusEl.classList.toggle("error", !!this.error);
    if (this.error) this.statusEl.textContent = this.error;
    else if (!s) this.statusEl.textContent = "Checking this computer…";
    else {
      const engine = s.running ? `Engine running (Ollama ${s.version})` : s.installed ? "Engine installed, starts when needed" : "The engine installs with your first model";
      this.statusEl.textContent = `${engine} · ${Math.round(s.ramGb)} GB memory · ${s.gpu ? `${s.gpu} graphics` : "no graphics card, runs on the processor"}`;
    }
    const rec = s ? recommendedTier(s.ramGb, !!s.gpu) : null;
    this.tiersEl.replaceChildren(...LOCAL_MODELS.map((m) => this.card(m, rec?.tier === m.tier)));
  }

  private card(m: LocalModelOption, recommended: boolean): HTMLElement {
    const cur = this.current();
    const selected = cur.provider === "local" && cur.localModel === m.model;
    const installed = this.has(m.model);
    const el = document.createElement("div");
    el.className = `tier${selected ? " selected" : ""}`;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = m.label;
    if (recommended) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "Best fit";
      b.title = "The most capable model this computer runs comfortably";
      name.append(b);
    }
    const tight = this.status && this.status.ramGb < m.ramGb * 0.9;
    const meta = div("meta", `${m.download} download · needs ${m.ramGb} GB memory${tight ? " (more than this computer has)" : ""}`);
    const blurb = div("blurb", m.blurb);
    const scores = div("scores", m.scores);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn${installed ? "" : " primary"}`;
    const mine = this.busy?.model === m.model;
    btn.textContent = mine ? "Cancel" : selected ? "In use" : installed ? "Use" : "Install";
    btn.disabled = (selected && !mine) || (!!this.busy && !mine);
    btn.onclick = () => (mine ? void localAI.cancel() : void this.pick(m));
    el.append(name, meta, blurb, scores, btn);
    if (mine) {
      const p = this.busy!.progress;
      const bar = document.createElement("progress");
      if (p && p.total > 0) {
        bar.max = p.total;
        bar.value = p.done;
      }
      const pct = p && p.total > 0 ? ` ${Math.floor((p.done / p.total) * 100)}% (${gb(p.done)} of ${gb(p.total)})` : "…";
      el.append(bar, div("pstatus", `${p?.status ?? "Starting"}${pct}`));
    }
    return el;
  }

  private async pick(m: LocalModelOption): Promise<void> {
    this.error = "";
    this.busy = { model: m.model, progress: null };
    this.render();
    const stop = await localAI.onProgress((p) => {
      if (this.busy) this.busy.progress = p;
      this.render();
    });
    try {
      if (!this.status?.installed) await localAI.install();
      await localAI.start();
      if (!this.has(m.model)) await localAI.pull(m.model);
      this.busy = null;
      await this.refresh();
      await this.choose(m.model, this.status?.url ?? "http://127.0.0.1:11434");
    } catch (err) {
      const msg = String(err);
      this.error = msg === "cancelled" ? "" : `Couldn't install ${m.label}: ${msg}`;
    } finally {
      stop();
      this.busy = null;
      await this.refresh();
    }
  }
}

function div(className: string, text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  d.textContent = text;
  return d;
}
