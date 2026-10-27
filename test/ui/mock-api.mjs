// A scripted stand-in for the Messages API, so UI tests run the real agent
// loop (streaming, tools, interjections, stop) without a key or any cost.
import http from "node:http";

export function startMockApi(port = 8791) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: json });
    const turn = json.messages.filter((m) => m.role === "assistant").length;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => (closed = true));
    const send = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const blocks = script(turn, json.messages);
    send("message_start", {
      message: { id: `msg_${turn}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } },
    });
    for (const [i, b] of blocks.entries()) {
      await sleep(b.delay ?? 120);
      if (closed) return;
      if (b.type === "thinking") {
        send("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        send("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: b.text } });
        send("content_block_delta", { index: i, delta: { type: "signature_delta", signature: "sig" } });
      } else if (b.type === "text") {
        send("content_block_start", { index: i, content_block: { type: "text", text: "" } });
        for (const word of b.text.split(/(?<= )/)) {
          send("content_block_delta", { index: i, delta: { type: "text_delta", text: word } });
          await sleep(15);
        }
      } else {
        send("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${turn}_${i}`, name: b.name, input: {} } });
        send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      send("content_block_stop", { index: i });
    }
    const usesTool = blocks.some((b) => b.type === "tool");
    send("message_delta", { delta: { stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 300 } });
    send("message_stop", {});
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, requests })));
}

/** Ids returned by earlier tool calls, in order. */
function returnedIds(messages) {
  const ids = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const c of m.content) {
      if (c.type !== "tool_result" || typeof c.content !== "string") continue;
      try {
        const r = JSON.parse(c.content);
        if (r.id) ids.push(r.id);
      } catch {}
    }
  }
  return ids;
}

function script(turn, messages) {
  const ids = returnedIds(messages);
  switch (turn) {
    case 0:
      return [
        { type: "text", text: "I'll make a 60 × 40 mm plate with a mounting hole." },
        { type: "thinking", text: "Starting with the base plate." },
        { type: "tool", name: "add_shape", input: { kind: "box", name: "Plate", width: 60, depth: 40, height: 6, fillet: 2, position: [0, 0, 3], color: "#3fa7d6" } },
      ];
    case 1:
      return [
        { type: "thinking", text: "Now the hole through the middle.", delay: 1500 },
        { type: "tool", name: "add_shape", input: { kind: "cylinder", name: "Hole", radius: 6, height: 10, position: [0, 0, 3], hole: true } },
      ];
    case 2:
      return [{ type: "tool", name: "group_shapes", input: { ids: ids.slice(0, 2), name: "Bracket" } }];
    case 3:
      return [
        { type: "tool", name: "update_shape", input: { id: ids[2], color: "#e8553e" } },
        { type: "tool", name: "view_snapshot", input: { view: "iso" } },
      ];
    default:
      return [{ type: "text", text: "Done: a **red** bracket plate with a 12 mm hole. You can change the hole size in the inspector." }];
  }
}
