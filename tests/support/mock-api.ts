import assert from "node:assert/strict";

export interface WireMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_call_id?: string;
}
export interface WireRequest {
  model: string;
  messages: WireMessage[];
  tools?: Array<{ function: { name: string } }>;
  max_tokens?: number;
}
export interface Reply {
  text?: string;
  calls?: Array<{ name: string; args: unknown }>;
  status?: number;
  finishReason?: string;
  waitForAbort?: boolean;
}

export function messageText(message: WireMessage) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

// This replaces HTTP transport only. Pi still parses SSE, dispatches/validates tools and loops.
export function mockApi(respond: (request: WireRequest, index: number) => Reply) {
  const requests: WireRequest[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, "http://model.test/v1/chat/completions");
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body);
    const body = JSON.parse(raw) as WireRequest;
    requests.push(body);
    const reply = respond(body, requests.length - 1);
    if (reply.waitForAbort) {
      const signal = input instanceof Request ? input.signal : init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (reply.status) return new Response(JSON.stringify({ error: { message: "test API unavailable" } }), { status: reply.status, headers: { "content-type": "application/json" } });
    const toolCalls = reply.calls?.map((call, index) => ({
      index, id: `call-${requests.length}-${index}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    const base = { id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", ...(reply.text !== undefined ? { content: reply.text } : {}), ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (toolCalls ? "tool_calls" : "stop") }] },
      { ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  return { transport, requests };
}
