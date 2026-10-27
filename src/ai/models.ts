// Local models the app can install with one click, from lightest to most capable.
// Scores are the publishers' own: BFCL-V4 measures function calling, τ²-bench
// multi-step tool use. Higher tiers make fewer mistakes but need more memory.

export interface LocalModelOption {
  tier: "light" | "better" | "best";
  label: string;
  /** Ollama model tag. */
  model: string;
  download: string;
  /** Memory the computer should have for it to run comfortably. */
  ramGb: number;
  blurb: string;
  scores: string;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  {
    tier: "light",
    label: "Light",
    model: "qwen3.5:4b",
    download: "3.3 GB",
    ramGb: 8,
    blurb: "Runs on most computers. Good for simple parts; check what it builds.",
    scores: "Qwen3.5 4B · BFCL-V4 50.3 · τ²-bench 79.9",
  },
  {
    tier: "better",
    label: "Better",
    model: "qwen3.5:9b",
    download: "6.6 GB",
    ramGb: 16,
    blurb: "Noticeably more accurate with tools, still quick on a recent laptop.",
    scores: "Qwen3.5 9B · BFCL-V4 66.1 · τ²-bench 79.1",
  },
  {
    tier: "best",
    label: "Best local",
    model: "qwen3.5:35b",
    download: "22 GB",
    ramGb: 32,
    blurb: "The strongest local option. Only 3B of its 35B parameters work on each word, so it stays usable without a big graphics card.",
    scores: "Qwen3.5 35B-A3B · BFCL-V4 67.3 · τ²-bench 81.2",
  },
];

/**
 * The most capable tier this computer runs comfortably. Without a GPU the
 * processor does all the work, so a bigger model needs twice the memory
 * headroom before it's worth the wait.
 */
export function recommendedTier(ramGb: number, gpu: boolean): LocalModelOption {
  const need = (m: LocalModelOption) => (gpu ? m.ramGb : m.ramGb * 2) * 0.9;
  return [...LOCAL_MODELS].reverse().find((m) => ramGb >= need(m)) ?? LOCAL_MODELS[0];
}
