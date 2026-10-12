import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  compressMcpResponse,
  responseEncoding,
} from "../src/lib/http-compression";

function request(encoding?: string) {
  return new Request("https://classroom.example.com/mcp", {
    method: "POST",
    headers: encoding === undefined ? {} : { "Accept-Encoding": encoding },
  });
}

test("negotiates gzip, identity, wildcard and explicit exclusions", () => {
  for (const [header, expected] of [
    [null, "identity"],
    ["", "identity"],
    ["br, gzip, deflate", "gzip"],
    ["GZIP; q=0.5", "gzip"],
    ["gzip ; q=0.5", "gzip"],
    ["gzip;q=0", "identity"],
    ["*;q=0.5", "gzip"],
    ["gzip;q=0, *;q=1", "identity"],
    ["gzip;q=0.5, identity;q=1", "identity"],
    ["br", "identity"],
    ["gzip;q=bogus", "identity"],
    ["gzip;q=2", "identity"],
    ["gzip;q=0, identity;q=0", undefined],
    ["*;q=0", undefined],
    ["gzip;q=1, *;q=0", "gzip"],
  ] as const)
    expect(responseEncoding(header)).toBe(expected);
});

test("compresses JSON losslessly, reduces repetitive payload and maintains headers", async () => {
  const text = JSON.stringify({
    assignments: Array.from({ length: 100 }, () => ({
      title: "Essay",
      description: "Read the handout and submit your assignment.",
    })),
  });
  const result = compressMcpResponse(
    request("gzip"),
    new Response(text, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(text.length),
        "Cache-Control": "no-store",
        Vary: "Origin",
        ETag: '"uncompressed"',
        "Content-Digest": "old",
      },
    }),
  );
  const compressed = new Uint8Array(await result.arrayBuffer());
  expect(result.headers.get("Content-Encoding")).toBe("gzip");
  expect(result.headers.get("Content-Type")).toBe("application/json");
  expect(result.headers.get("Vary")).toBe("Origin, Accept-Encoding");
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(result.headers.has("Content-Length")).toBe(false);
  expect(result.headers.has("ETag")).toBe(false);
  expect(result.headers.has("Content-Digest")).toBe(false);
  expect(gunzipSync(compressed).toString()).toBe(text);
  expect(compressed.length).toBeLessThan(text.length / 4);
});

test("clients without gzip receive identical uncompressed content and Vary", async () => {
  const result = compressMcpResponse(
    request("br"),
    Response.json({ original: true }),
  );
  expect(result.headers.has("Content-Encoding")).toBe(false);
  expect(result.headers.get("Vary")).toBe("Accept-Encoding");
  expect(await result.json()).toEqual({ original: true });
});

test("does not double-compress, encode empty/error responses or raw file content", async () => {
  const encoded = new Response("encoded", {
    headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
  });
  expect(compressMcpResponse(request("gzip"), encoded)).toBe(encoded);
  const empty = new Response(null, { status: 204 });
  expect(compressMcpResponse(request("gzip"), empty)).toBe(empty);
  const error = Response.json({ error: "invalid_token" }, { status: 401 });
  expect(compressMcpResponse(request("gzip"), error)).toBe(error);
  const file = new Response("%PDF", {
    headers: { "Content-Type": "application/pdf" },
  });
  expect(compressMcpResponse(request("gzip"), file)).toBe(file);
  const star = compressMcpResponse(
    request("gzip"),
    Response.json({}, { headers: { Vary: "*" } }),
  );
  expect(star.headers.get("Vary")).toBe("*");
  await star.arrayBuffer();
});

test("rejects requests explicitly refusing all supported encodings and cancels body", async () => {
  let cancelled = false;
  const source = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const result = compressMcpResponse(
    request("gzip;q=0, identity;q=0"),
    new Response(source, { headers: { "Content-Type": "application/json" } }),
  );
  expect(result.status).toBe(406);
  expect(await result.text()).toContain("Accept gzip or identity");
  expect(cancelled).toBe(true);
});

test("SSE is decoded incrementally before upstream closes", async () => {
  const encoder = new TextEncoder();
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const first = 'event: message\ndata: {"progress":1}\n\n';
  const second = 'event: message\ndata: {"progress":2}\n\n';
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(encoder.encode(first));
    },
  });
  const response = compressMcpResponse(
    request("gzip"),
    new Response(source, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
  );
  expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
  expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  const reader = response.body
    ?.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  if (!reader) throw new Error("Missing body");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("gzip buffered SSE until close")),
          1000,
        );
      }),
    ]);
    expect(new TextDecoder().decode(result.value)).toBe(first);
    sourceController?.enqueue(encoder.encode(second));
    sourceController?.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
    expect(Buffer.concat(chunks).toString()).toBe(second);
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
});

test("client cancellation propagates upstream without unhandled stream errors", async () => {
  let cancelled: () => void = () => {};
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: initial\n\n"));
    },
    cancel() {
      cancelled();
    },
  });
  const response = compressMcpResponse(
    request("gzip"),
    new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
  );
  await response.body?.cancel();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Upstream not cancelled")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});

test("upstream stream failure surfaces to the compressed response reader", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("source failed"));
    },
  });
  const response = compressMcpResponse(
    request("gzip"),
    new Response(source, { headers: { "Content-Type": "application/json" } }),
  );
  await expect(response.arrayBuffer()).rejects.toThrow("source failed");
});
