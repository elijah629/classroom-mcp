import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { allMethods, methodInputSchema, stableDiscovery } from "./discovery";
import catalog from "./discovery/catalog.json";
import { assertGoogleScopes, describeError, googleJson } from "./google-api";
import {
  googleAccessTokenFromAuthInfo,
  googleScopesFromAuthInfo,
} from "./mcp-token";

export type ApiArguments = Record<string, unknown>;
export interface GoogleContext {
  accessToken: string;
  scopes?: string[];
}
export function googleContext(auth?: AuthInfo): GoogleContext {
  if (!auth) throw new Error("Authentication context missing");
  return {
    accessToken: googleAccessTokenFromAuthInfo(auth),
    scopes: googleScopesFromAuthInfo(auth),
  };
}
export function methodAnnotations(method: string, id: string) {
  const readOnly = method === "GET";
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && !id.endsWith(".create"),
    idempotentHint: readOnly || method === "DELETE" || method === "PUT",
    openWorldHint: true,
  };
}
export function buildClassroomRequest(methodId: string, args: ApiArguments) {
  const method = allMethods.get(methodId);
  if (!method) throw new Error(`Unknown Classroom method: ${methodId}`);
  const path = method.path.replace(
    /\{([^}]+)\}/g,
    (_match, parameter: string) => {
      const value = args[parameter];
      if (typeof value !== "string" || !value)
        throw new Error(`Missing path parameter: ${parameter}`);
      return encodeURIComponent(value);
    },
  );
  const url = new URL(path, stableDiscovery.rootUrl);
  const parameters = { ...stableDiscovery.parameters, ...method.parameters };
  for (const [name, definition] of Object.entries(parameters)) {
    if (
      definition.location !== "query" ||
      [
        "access_token",
        "oauth_token",
        "key",
        "callback",
        "alt",
        "uploadType",
        "upload_protocol",
      ].includes(name)
    )
      continue;
    const value = args[name];
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      url.searchParams.append(name, String(item));
  }
  const body = args.body;
  if (
    Object.hasOwn(args, "previewVersion") ||
    (body && typeof body === "object" && Object.hasOwn(body, "previewVersion"))
  )
    throw new Error("Only stable Classroom API calls are supported.");
  const headers = new Headers();
  const init: RequestInit = { method: method.httpMethod, headers };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  return { url, init, method };
}
export async function callClassroom<T = Record<string, unknown>>(
  context: GoogleContext,
  methodId: string,
  args: ApiArguments = {},
): Promise<T> {
  const { url, init, method } = buildClassroomRequest(methodId, args);
  assertGoogleScopes(context.scopes, method.scopes ?? []);
  return googleJson<T>(context.accessToken, url, init);
}
export function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
export function toolError(error: unknown) {
  return { ...toolResult({ error: describeError(error) }), isError: true };
}
export function registerClassroomTools(server: McpServer, auth?: AuthInfo) {
  for (const entry of catalog.tools) {
    const method = allMethods.get(entry.methodId);
    if (!method) throw new Error(`Missing method ${entry.methodId}`);
    const schema = z.fromJSONSchema(methodInputSchema(method));
    server.registerTool(
      entry.name,
      {
        title: method.id.replace(/^classroom\./, ""),
        description: `${method.description}\nOAuth: one of ${(method.scopes ?? []).join(", ")}. Google enforces account role, domain, licensing, add-on and project-association restrictions. Stable discovery method. Pass body for request JSON. List methods return one page and nextPageToken; pass it as pageToken to continue. Responses retain all Google fields.`,
        inputSchema: schema,
        annotations: methodAnnotations(method.httpMethod, method.id),
        _meta: {
          googleMethodId: method.id,
          stable: true,
        },
      },
      async (input) => {
        try {
          return toolResult(
            await callClassroom(
              googleContext(auth),
              method.id,
              input as ApiArguments,
            ),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
}
