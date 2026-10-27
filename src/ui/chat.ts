import type { AgentUI } from "../ai/agent";

const TOOL_LABELS: Record<string, string> = {
  add_shape: "Adding a shape…",
  update_shape: "Adjusting a shape…",
  move_shapes: "Moving…",
  rotate_shapes: "Rotating…",
  group_shapes: "Grouping…",
  ungroup: "Ungrouping…",
  duplicate_shape: "Duplicating…",
  delete_shapes: "Deleting…",
  get_scene: "Reading the scene…",
  view_snapshot: "Taking a look…",
};

const SUGGESTIONS = [
  "A coffee mug with a handle",
  "A phone stand with a slot for the charging cable",
  "A 6-slot organiser for AA batteries",
  "A small house with a pitched roof and a door",
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Just enough Markdown for chat replies: paragraphs, lists, bold, code. */
function renderMarkdown(src: string): string {
  const inline = (t: string) =>
    escapeHtml(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim())) {
      list.push(...lines.filter((l) => l.trim()).map((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, "")));
      continue;
    }
    flush();
    out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  flush();
  return out.join("");
}

export class ChatView implements AgentUI {
  private current: { el: HTMLElement; text: string } | null = null;
  private pending: HTMLButtonElement | null = null;
  private queued: HTMLElement[] = [];
  private totals = { input: 0, output: 0 };

  constructor(
    private log: HTMLElement,
    private status: HTMLElement,
    private stopBtn: HTMLButtonElement,
    private sendBtn: HTMLButtonElement,
    private input: HTMLTextAreaElement,
    private usageEl: HTMLElement,
    private onSelect: (ids: string[]) => void,
    private onSuggestion: (text: string) => void,
  ) {
    this.empty();
  }

  empty(): void {
    this.log.replaceChildren();
    this.current = null;
    this.totals = { input: 0, output: 0 };
    this.usageEl.textContent = "";
    const box = document.createElement("div");
    box.className = "suggestions";
    const p = document.createElement("p");
    p.textContent = "Tell me what to make. You'll see it built step by step, and you can type at any time to change course.";
    box.append(p);
    for (const s of SUGGESTIONS) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = s;
      b.onclick = () => this.onSuggestion(s);
      box.append(b);
    }
    this.log.append(box);
  }

  private add(el: HTMLElement): HTMLElement {
    this.log.querySelector(".suggestions")?.remove();
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    this.log.append(el);
    if (nearBottom) this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  user(text: string, queued: boolean): void {
    const el = document.createElement("div");
    el.className = `msg user${queued ? " queued interject" : ""}`;
    el.textContent = text;
    this.add(el);
    if (queued) this.queued.push(el);
    this.current = null;
  }

  busy(on: boolean): void {
    this.status.textContent = on ? "Working" : "";
    this.status.classList.toggle("busy", on);
    this.stopBtn.hidden = !on;
    this.sendBtn.textContent = on ? "Interject" : "Send";
    this.input.placeholder = on ? "Interject: change the size, colour, add a part…" : "Describe what to make, e.g. “a phone stand with a cable slot”";
    if (!on) {
      this.clearPending();
      for (const q of this.queued) q.classList.remove("queued");
      this.queued = [];
    }
  }

  text(delta: string, blockStart: boolean): void {
    if (blockStart || !this.current) {
      const el = document.createElement("div");
      el.className = "msg assistant";
      this.current = { el: this.add(el), text: "" };
    }
    if (!delta) return;
    this.current.text += delta;
    this.current.el.innerHTML = renderMarkdown(this.current.text);
    this.log.scrollTop = this.log.scrollHeight;
  }

  progress(note: string): void {
    const el = document.createElement("div");
    el.className = "msg progress";
    el.textContent = note;
    this.add(el);
    this.current = null;
  }

  toolPending(name: string): void {
    this.clearPending();
    const el = document.createElement("button");
    el.className = "msg tool pending";
    el.innerHTML = `<span class="dot"></span><span></span>`;
    el.lastElementChild!.textContent = TOOL_LABELS[name] ?? name;
    this.pending = this.add(el) as HTMLButtonElement;
    this.current = null;
  }

  toolDone(summary: string, isError: boolean, touched: string[]): void {
    const el = this.pending ?? (this.add(document.createElement("button")) as HTMLButtonElement);
    this.pending = null;
    el.className = `msg tool${isError ? " err" : ""}`;
    el.innerHTML = `<span class="dot"></span><span></span>`;
    el.lastElementChild!.textContent = summary;
    if (touched.length) {
      el.title = "Select";
      el.onclick = () => this.onSelect(touched);
    }
    this.current = null;
  }

  private clearPending(): void {
    // A pending chip whose call never ran (stopped or cut off).
    if (this.pending) this.pending.remove();
    this.pending = null;
  }

  interjectionDelivered(text: string): void {
    const el = this.queued.find((q) => q.textContent === text);
    if (el) {
      el.classList.remove("queued");
      this.queued = this.queued.filter((q) => q !== el);
    }
  }

  error(message: string): void {
    const el = document.createElement("div");
    el.className = "msg error";
    el.textContent = message;
    this.add(el);
    this.current = null;
  }

  usage(input: number, output: number): void {
    this.totals.input += input;
    this.totals.output += output;
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    this.usageEl.textContent = `${k(this.totals.input)} in · ${k(this.totals.output)} out tokens`;
  }
}
