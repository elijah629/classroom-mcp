import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";

// Only advertise gzip when the caller accepts it. Explicit exclusions override
// wildcard support, and an explicit identity preference is respected.
export function responseEncoding(
  header: string | null,
): "gzip" | "identity" | undefined {
  if (!header?.trim()) return "identity";
  const qualities = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const quality = parameters
      .map((value) => value.trim())
      .find((value) => value.startsWith("q="));
    const valid =
      !quality || /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality);
    qualities.set(
      name.trim(),
      valid ? (quality ? Number(quality.slice(2)) : 1) : 0,
    );
  }
  const gzip = qualities.get("gzip") ?? qualities.get("*") ?? 0;
  const identity =
    qualities.get("identity") ?? (qualities.get("*") === 0 ? 0 : undefined);
  if (gzip > 0 && (identity === undefined || gzip >= identity)) return "gzip";
  if (identity !== 0) return "identity";
  return undefined;
}

export function compressMcpResponse(
  request: Request,
  response: Response,
): Response {
  const type = response.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    !response.body ||
    !response.ok ||
    request.method === "HEAD" ||
    response.headers.has("Content-Encoding") ||
    (type !== "application/json" &&
      type !== "text/event-stream" &&
      !type?.endsWith("+json"))
  )
    return response;
  const headers = new Headers(response.headers);
  const vary =
    headers
      .get("Vary")
      ?.split(",")
      .map((value) => value.trim()) ?? [];
  if (
    !vary.some(
      (value) => value === "*" || value.toLowerCase() === "accept-encoding",
    )
  )
    headers.set("Vary", [...vary, "Accept-Encoding"].join(", "));
  const encoding = responseEncoding(request.headers.get("Accept-Encoding"));
  if (!encoding) {
    void response.body.cancel().catch(() => {});
    return new Response(
      "No acceptable response encoding. Accept gzip or identity.",
      {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          Vary: headers.get("Vary") ?? "Accept-Encoding",
        },
      },
    );
  }
  if (encoding === "identity")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

  // This is origin content encoding, not an intermediary content transformation.
  // Retain SDK no-transform/cache controls. Z_SYNC_FLUSH releases each SSE chunk
  // promptly; pipeline keeps backpressure and cancels upstream on disconnect.
  // DOM and Node/Bun declare different Web Stream extensions; runtime streams
  // interoperate through this boundary without changing their bytes.
  const input = Readable.fromWeb(
    response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  const gzip = createGzip({
    level: constants.Z_DEFAULT_COMPRESSION,
    flush: constants.Z_SYNC_FLUSH,
  });
  // pipeline propagates source errors to the HTTP stream. Consume its rejection
  // here because Response exposes the actual stream error to its reader.
  void pipeline(input, gzip).catch(() => {});
  const body = Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>;
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Content-MD5");
  headers.delete("Content-Digest");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
