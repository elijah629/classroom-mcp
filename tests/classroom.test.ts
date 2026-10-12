import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/client";
import { type AuthInfo, InMemoryTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  attachmentReferences,
  collectOriginalFiles,
  normalizeAttachment,
  readOriginalFile,
} from "../src/lib/attachments";
import {
  buildClassroomRequest,
  callClassroom,
  googleContext,
} from "../src/lib/classroom-api";
import { GOOGLE_SCOPES } from "../src/lib/config";
import {
  allMethods,
  methodInputSchema,
  stableMethods,
} from "../src/lib/discovery";
import catalog from "../src/lib/discovery/catalog.json";
import {
  assertGoogleScopes,
  describeError,
  GoogleApiError,
  googleJson,
  mapConcurrent,
} from "../src/lib/google-api";
import { boundWorkflow, buildMcpServer } from "../src/lib/mcp-server";
import {
  issueMcpAccessToken,
  issueMcpRefreshToken,
  readMcpRefreshToken,
  verifyMcpAccessToken,
} from "../src/lib/mcp-token";
import {
  assignmentBundle,
  courseBundle,
  listSource,
  overview,
  submitAssignment,
  type WorkflowOptions,
} from "../src/lib/workflows";

const originalFetch = globalThis.fetch;
const savedEnvironment = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});
const context = {
  accessToken: "test-google-token",
  scopes: [...GOOGLE_SCOPES],
};
const auth: AuthInfo = {
  token: "test-mcp-token",
  clientId: "test-client",
  scopes: ["mcp"],
  extra: {
    googleAccessToken: context.accessToken,
    googleScopes: context.scopes,
  },
};
function mockFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    handler(
      new URL(input instanceof Request ? input.url : String(input)),
      init ?? {},
    )) as typeof fetch;
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const options: WorkflowOptions = {
  maxItemsPerSource: 50,
  maxCourses: 10,
  includePosts: true,
  includeArchived: false,
  includeNoDue: true,
};
async function protocolClient() {
  const server = buildMcpServer(auth);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("Discovery and independent methods", () => {
  test("every stable method is registered once, named within client limits and has resolvable schemas", async () => {
    const connection = await protocolClient();
    try {
      const listed = await connection.client.listTools();
      expect(catalog.tools.length).toBe(allMethods.size);
      expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(
        allMethods.size,
      );
      const names = new Set(listed.tools.map((tool) => tool.name));
      expect(JSON.stringify(listed.tools)).not.toContain("previewVersion");
      expect(JSON.stringify(listed.tools)).not.toContain("DEVELOPER_PREVIEW");
      for (const method of stableMethods) {
        const entry = catalog.tools.find((tool) => tool.methodId === method.id);
        expect(entry).toBeDefined();
        expect(names.has(entry?.name ?? "")).toBe(true);
        expect((entry?.name.length ?? 0) <= 64).toBe(true);
        expect(() => z.fromJSONSchema(methodInputSchema(method))).not.toThrow();
      }
      expect(listed.tools.length).toBe(allMethods.size + 7);
      const mutating = listed.tools.find(
        (tool) => tool.name === "classroom_courses_delete",
      );
      expect(mutating?.annotations?.readOnlyHint).toBe(false);
      expect(mutating?.annotations?.destructiveHint).toBe(true);
    } finally {
      await connection.close();
    }
  });
  test("schema rejects missing path/body and invalid enum but retains request fields", () => {
    const method = allMethods.get("classroom.courses.create");
    if (!method) throw Error("missing method");
    const schema = z.fromJSONSchema(methodInputSchema(method));
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ body: { name: "Course", courseState: "ACTIVE" } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ body: { courseState: "not-an-enum" } }).success,
    ).toBe(false);
  });
  test("path escaping, repeated queries, fields and updateMask pass correctly", () => {
    const get = buildClassroomRequest("classroom.courses.get", {
      id: "school/a?b",
      fields: "id,name",
    });
    expect(get.url.pathname).toBe("/v1/courses/school%2Fa%3Fb");
    expect(get.url.searchParams.get("fields")).toBe("id,name");
    const list = buildClassroomRequest("classroom.courses.list", {
      courseStates: ["ACTIVE", "ARCHIVED"],
      pageToken: "second page",
    });
    expect(list.url.searchParams.getAll("courseStates")).toEqual([
      "ACTIVE",
      "ARCHIVED",
    ]);
    const patch = buildClassroomRequest("classroom.courses.patch", {
      id: "course",
      updateMask: "name,room",
      body: { name: "New" },
    });
    expect(patch.url.searchParams.get("updateMask")).toBe("name,room");
    expect(patch.init.body).toBe('{"name":"New"}');
    expect(patch.init.method).toBe("PATCH");
  });
  test("stable tools reject preview arguments and never send preview headers or keys", () => {
    const method = allMethods.get("classroom.courses.get");
    if (!method) throw Error("missing method");
    const schema = z.fromJSONSchema(methodInputSchema(method));
    expect(
      schema.safeParse({ id: "c", previewVersion: "anything" }).success,
    ).toBe(false);
    expect(() =>
      buildClassroomRequest(method.id, { id: "c", previewVersion: "anything" }),
    ).toThrow("Only stable");
    expect(() =>
      buildClassroomRequest(
        "classroom.courses.courseWork.studentSubmissions.turnIn",
        {
          courseId: "c",
          courseWorkId: "w",
          id: "s",
          body: { previewVersion: "anything" },
        },
      ),
    ).toThrow("Only stable");
    const request = buildClassroomRequest(method.id, { id: "c" });
    expect(request.url.searchParams.has("key")).toBe(false);
    expect(request.url.searchParams.has("previewVersion")).toBe(false);
    expect(new Headers(request.init.headers).has("X-Goog-Visibilities")).toBe(
      false,
    );
  });
  test("independent raw calls preserve pages and unknown Google fields; handle empty success", async () => {
    mockFetch((url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer test-google-token",
      );
      return url.pathname.endsWith("/courses")
        ? json({
            courses: [{ id: "c", futureField: 42 }],
            nextPageToken: "next",
          })
        : new Response(null, { status: 204 });
    });
    expect(
      await callClassroom<Record<string, unknown>>(
        context,
        "classroom.courses.list",
      ),
    ).toEqual({
      courses: [{ id: "c", futureField: 42 }],
      nextPageToken: "next",
    });
    expect(
      await callClassroom<Record<string, unknown>>(
        context,
        "classroom.courses.delete",
        { id: "c" },
      ),
    ).toEqual({});
    expect(
      await googleJson<Record<string, unknown>>(
        context.accessToken,
        "https://classroom.googleapis.com/v1/empty",
      ),
    ).toEqual({});
  });
  test("real protocol validates arguments and calls student, teacher, admin methods", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url.pathname);
      return json({ preserved: { nested: true } });
    });
    const connection = await protocolClient();
    try {
      for (const [name, args] of [
        ["classroom_courses_courseWork_get", { courseId: "c", id: "w" }],
        [
          "classroom_courses_courseWork_create",
          { courseId: "c", body: { title: "Test", workType: "ASSIGNMENT" } },
        ],
        [
          "classroom_courses_create",
          { body: { name: "Course", ownerId: "me" } },
        ],
      ] as const) {
        const result = await connection.client.callTool({
          name,
          arguments: args,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
          preserved: { nested: true },
        });
      }
      expect(calls.length).toBe(3);
      const invalid = await connection.client.callTool({
        name: "classroom_courses_get",
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
      expect(calls.length).toBe(3);
    } finally {
      await connection.close();
    }
  });
});

describe("Google scopes and errors", () => {
  test("missing or legacy grants require reconnect before requesting Google", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return json({});
    });
    await expect(
      callClassroom({ accessToken: "old" }, "classroom.courses.list"),
    ).rejects.toThrow("Reconnect");
    expect(calls).toBe(0);
    expect(() => assertGoogleScopes(["other"], ["scope"])).toThrow("Reconnect");
  });
  test("Google status/reasons/details retained; distinct actionable errors", () => {
    for (const [status, message, kind] of [
      [403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "missing_scope"],
      [
        403,
        "Developer Console project association required",
        "project_association",
      ],
      [403, "License required", "permission_denied"],
      [403, "Role does not permit this action", "permission_denied"],
      [404, "Unknown course", "not_found"],
    ] as const) {
      const detail = { reason: message };
      const error = new GoogleApiError(
        "failed",
        status,
        JSON.stringify({
          error: { message, details: [detail], status: "PERMISSION_DENIED" },
        }),
      );
      const result = describeError(error);
      expect(result.kind).toBe(kind);
      expect(result.status).toBe(status);
      expect(result.google).toEqual({
        message,
        details: [detail],
        status: "PERMISSION_DENIED",
      });
    }
  });
  test("access/refresh JWEs preserve granted scopes without exposing Google refresh token", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long";
    process.env.APP_ORIGIN = "https://classroom.example.com";
    const identity = {
      clientId: "client",
      googleSub: "sub",
      googleEmail: "student@example.com",
      scopes: ["mcp"],
      googleScopes: ["granted"],
    };
    const access = await issueMcpAccessToken({
      ...identity,
      googleAccessToken: "access",
    });
    const verified = await verifyMcpAccessToken(access.token);
    expect(googleContext(verified).scopes).toEqual(["granted"]);
    expect(verified.extra?.googleRefreshToken).toBeUndefined();
    const refresh = await issueMcpRefreshToken({
      ...identity,
      googleRefreshToken: "refresh",
    });
    expect((await readMcpRefreshToken(refresh)).googleScopes).toEqual([
      "granted",
    ]);
  });
  test("refresh route retains omitted scope, accepts changed scope and rotates upstream refresh grant", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long";
    process.env.APP_ORIGIN = "https://classroom.example.com";
    process.env.GOOGLE_CLIENT_ID = "test-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    const { POST: tokenPost } = await import("../src/app/oauth/token/route");
    const token = await issueMcpRefreshToken({
      clientId: "client",
      googleSub: "sub",
      googleEmail: "student@example.com",
      scopes: ["mcp"],
      googleScopes: ["old-grant"],
      googleRefreshToken: "original-refresh",
    });
    for (const scope of [undefined, "new-grant"]) {
      mockFetch(() =>
        json({
          access_token: "new-access",
          expires_in: 3600,
          token_type: "Bearer",
          refresh_token: "rotated-upstream",
          ...(scope ? { scope } : {}),
        }),
      );
      const response = await tokenPost(
        new Request("https://classroom.example.com/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: "client",
          }),
        }),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      const verified = await verifyMcpAccessToken(data.access_token);
      expect(googleContext(verified).scopes).toEqual([scope ?? "old-grant"]);
      expect(
        (await readMcpRefreshToken(data.refresh_token)).googleRefreshToken,
      ).toBe("rotated-upstream");
    }
  });
});

describe("Original attachments", () => {
  const pdf = new Uint8Array([
    37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 3, 10, 37, 37, 69, 79, 70,
  ]);
  function pdfMock(onMedia?: () => void) {
    mockFetch((url) => {
      if (url.searchParams.get("alt") === "media") {
        onMedia?.();
        return new Response(pdf, {
          headers: { "Content-Type": "application/pdf" },
        });
      }
      return json({
        id: url.pathname.split("/").at(-1),
        name: "original.pdf",
        mimeType: "application/pdf",
        size: String(pdf.length),
      });
    });
  }
  test("stored PDF bytes/hash and MIME remain exact", async () => {
    pdfMock();
    const result = await readOriginalFile(context, "pdf");
    expect(result.delivery).toBe("original");
    expect(result.file?.name).toBe("original.pdf");
    expect(result.resource?.mimeType).toBe("application/pdf");
    const restored = Buffer.from(result.resource?.blob ?? "", "base64");
    const hash = (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex");
    expect(hash(restored)).toBe(hash(pdf));
    expect(result.bytes).toBe(pdf.length);
    expect("text" in (result.resource ?? {})).toBe(false);
  });
  test("deduplicates original downloads, retaining all teacher/student references", async () => {
    let downloads = 0;
    pdfMock(() => {
      downloads++;
    });
    const refs = [
      ...attachmentReferences(
        [{ driveFile: { driveFile: { id: "pdf", title: "Handout" } } }],
        {
          source: "teacher",
          sourceType: "assignment",
          courseId: "c",
          courseWorkId: "w",
        },
      ),
      ...attachmentReferences([{ driveFile: { id: "pdf" } }], {
        source: "student",
        sourceType: "submission",
        courseId: "c",
        courseWorkId: "w",
      }),
    ];
    const result = await collectOriginalFiles(context, refs, true, true);
    expect(downloads).toBe(1);
    expect(result.resources.length).toBe(1);
    expect(result.files[0]?.references.length).toBe(2);
  });
  test("per-file declared and streamed size limits never deliver partial bytes", async () => {
    pdfMock();
    expect((await readOriginalFile(context, "pdf", 4)).delivery).toBe(
      "drive_mcp",
    );
    mockFetch((url) =>
      url.searchParams.get("alt")
        ? new Response(pdf)
        : json({ id: "pdf", mimeType: "application/pdf" }),
    );
    const streamed = await readOriginalFile(context, "pdf", 4);
    expect(streamed.delivery).toBe("drive_mcp");
    expect(streamed.resource).toBeUndefined();
    mockFetch((url) =>
      url.searchParams.get("alt")
        ? new Response(pdf, { headers: { "Content-Length": "9999" } })
        : json({ id: "pdf", mimeType: "application/pdf" }),
    );
    expect((await readOriginalFile(context, "pdf", 4)).delivery).toBe(
      "drive_mcp",
    );
  });
  test("Google-native and permission denied originals provide Drive handoff", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return json({
        id: "doc",
        mimeType: "application/vnd.google-apps.document",
      });
    });
    const native = await readOriginalFile(context, "doc");
    expect(native.delivery).toBe("drive_mcp");
    expect(native.reason).toContain("No implicit export");
    expect(calls).toBe(1);
    mockFetch(() =>
      json(
        {
          error: { message: "Permission denied", status: "PERMISSION_DENIED" },
        },
        403,
      ),
    );
    const denied = await readOriginalFile(context, "private");
    expect(denied.delivery).toBe("drive_mcp");
    expect(denied.error?.status).toBe(403);
    expect(denied.fileId).toBe("private");
  });
  test("file-count, total-byte and incompatible-client budgets hand off explicitly", async () => {
    pdfMock();
    const refs = attachmentReferences(
      Array.from({ length: 7 }, (_, index) => ({
        driveFile: { id: String(index) },
      })),
      { source: "teacher", sourceType: "material" },
    );
    const count = await collectOriginalFiles(context, refs, true, true);
    expect(count.resources.length).toBe(5);
    expect(count.files[5]?.reason).toContain("budget");
    const incompatible = await collectOriginalFiles(context, refs, true, false);
    expect(incompatible.resources.length).toBe(0);
    expect(incompatible.files[0]?.reason).toContain("Client");
    // Total-byte budget is also exercised directly through per-request remaining maximum.
    const overRemaining = await readOriginalFile(
      context,
      "pdf",
      pdf.length - 1,
    );
    expect(overRemaining.delivery).toBe("drive_mcp");
  });
  test("MCP resource read and attachment tool both return original bytes", async () => {
    pdfMock();
    const connection = await protocolClient();
    try {
      const resource = await connection.client.readResource({
        uri: "classroom-drive://files/pdf",
      });
      expect(resource.contents[0]).toMatchObject({
        blob: Buffer.from(pdf).toString("base64"),
        mimeType: "application/pdf",
      });
      const result = await connection.client.callTool({
        name: "classroom_read_attachment",
        arguments: { fileId: "pdf" },
      });
      const blocks = result.content as Array<Record<string, unknown>>;
      expect(blocks.some((block) => block.type === "resource")).toBe(true);
      expect(result.isError).not.toBe(true);
    } finally {
      await connection.close();
    }
  });
  test("all original attachment types normalized without discarding raw unknowns", () => {
    expect(
      normalizeAttachment({
        driveFile: { driveFile: { id: "d" }, shareMode: "VIEW" },
      }),
    ).toMatchObject({ kind: "drive", id: "d", shareMode: "VIEW" });
    expect(normalizeAttachment({ gem: { id: "g" } }).kind).toBe("gem");
    expect(normalizeAttachment({ notebook: { id: "n" } }).kind).toBe(
      "notebook",
    );
    expect(normalizeAttachment({ unknownNewType: true })).toEqual({
      kind: "unknown",
      raw: { unknownNewType: true },
    });
  });
});

describe("Bounded workflows and submission", () => {
  test("pagination continuation and oversized records are explicit", async () => {
    mockFetch((url) =>
      json({
        courses: [{ id: url.searchParams.get("pageToken") ?? "first" }],
        nextPageToken: "next",
      }),
    );
    const result = await listSource(
      context,
      "classroom.courses.list",
      "courses",
      {},
      { maxItems: 1, maxChars: 10000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.continuation?.arguments.pageToken).toBe("next");
    const tooBig = await listSource(
      context,
      "classroom.courses.list",
      "courses",
      {},
      { maxItems: 1, maxChars: 2 },
    );
    expect(tooBig.data).toEqual([]);
    expect(tooBig.continuation?.offset).toBe(0);
    const bounded = boundWorkflow(
      { big: "x".repeat(400000) },
      "classroom_overview",
      {},
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.continuation).toBeDefined();
  });
  test("partial course/source failures preserve other course results and avoid inferred missing status", async () => {
    mockFetch((url) => {
      if (url.pathname === "/v1/courses")
        return json({ courses: [{ id: "good" }, { id: "bad" }] });
      if (url.pathname.includes("bad"))
        return json({ error: { message: "Denied" } }, 403);
      if (url.pathname.endsWith("/studentSubmissions"))
        return json({ error: { message: "Submission denied" } }, 403);
      if (url.pathname.endsWith("/courseWork"))
        return json({
          courseWork: [
            {
              id: "w",
              courseId: "good",
              title: "Essay",
              dueDate: { year: 2020, month: 1, day: 1 },
              futureField: true,
            },
          ],
        });
      if (url.pathname.endsWith("/topics")) return json({ topic: [] });
      if (url.pathname.endsWith("/courseWorkMaterials"))
        return json({ courseWorkMaterial: [] });
      if (url.pathname.endsWith("/announcements"))
        return json({ announcements: [] });
      return json({ id: "good", name: "Course" });
    });
    const result = await overview(context, options);
    expect(result.courses.length).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.courses[0]?.assignments[0]?.status).toBe("unknown");
    expect(result.courses[0]?.sources.work.data[0]?.futureField).toBe(true);
    expect(result.courses[1]?.partial).toBe(true);
  });
  test("assignment bundle returns rubric failure alongside assignment/submission and source attachments", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/rubrics"))
        return json({ error: { message: "Permission denied" } }, 403);
      if (url.pathname.endsWith("/studentSubmissions"))
        return json({
          studentSubmissions: [
            {
              id: "s",
              courseWorkId: "w",
              assignmentSubmission: {
                attachments: [{ driveFile: { id: "my-file" } }],
              },
            },
          ],
        });
      if (url.pathname.endsWith("/courseWork/w"))
        return json({
          id: "w",
          courseId: "c",
          materials: [{ driveFile: { driveFile: { id: "teacher-file" } } }],
        });
      return json({ id: "c" });
    });
    const result = await assignmentBundle(context, "c", "w");
    expect(result.partial).toBe(true);
    expect(result.sources.work.data.length).toBe(1);
    expect(result.attachments.map((r) => r.source)).toEqual([
      "teacher",
      "student",
    ]);
  });
  test("bounded concurrency never exceeds chosen limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return value * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
  test("submission attachment success followed by denied turn-in reports partial completion, no retry", async () => {
    let writes = 0;
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init.method} ${url.pathname}`);
      if (url.pathname.endsWith(":modifyAttachments")) {
        writes++;
        return json({
          id: "s",
          state: "CREATED",
          courseWorkType: "ASSIGNMENT",
        });
      }
      if (url.pathname.endsWith(":turnIn")) {
        writes++;
        return json(
          {
            error: {
              message: "Developer Console project association required",
              status: "PERMISSION_DENIED",
            },
          },
          403,
        );
      }
      if (url.pathname.endsWith("/studentSubmissions"))
        return json({
          studentSubmissions: [
            { id: "s", state: "CREATED", courseWorkType: "ASSIGNMENT" },
          ],
        });
      return json({
        id: "s",
        state: "CREATED",
        assignmentSubmission: { attachments: [{ driveFile: { id: "d" } }] },
      });
    });
    const result = await submitAssignment(context, {
      courseId: "c",
      courseWorkId: "w",
      addAttachments: [{ driveFile: { id: "d" } }],
      turnIn: true,
    });
    expect(result.partial).toBe(true);
    expect(result.success).toBe(false);
    expect(writes).toBe(2);
    expect(result.steps.find((s) => s.step === "turn_in")?.status).toBe(
      "failed",
    );
    expect(calls.at(-1)).toContain("/studentSubmissions/s");
    expect(calls.some((call) => /reclaim|delete/.test(call))).toBe(false);
  });
  test("submission only modifies new attachments and defaults tool turnIn false", async () => {
    let turnIns = 0;
    let modifications = 0;
    mockFetch((url) => {
      if (url.pathname.endsWith(":turnIn")) turnIns++;
      if (url.pathname.endsWith(":modifyAttachments")) modifications++;
      const submission = {
        id: "s",
        courseWorkType: "ASSIGNMENT",
        state: "CREATED",
        assignmentSubmission: {
          attachments: [{ driveFile: { id: "existing" } }],
        },
      };
      return json(
        url.pathname.endsWith("/studentSubmissions")
          ? { studentSubmissions: [submission] }
          : submission,
      );
    });
    const connection = await protocolClient();
    try {
      const result = await connection.client.callTool({
        name: "classroom_submit_assignment",
        arguments: {
          courseId: "c",
          courseWorkId: "w",
          addAttachments: [{ driveFile: { id: "existing" } }],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(turnIns).toBe(0);
      expect(modifications).toBe(0);
    } finally {
      await connection.close();
    }
  });
  test("no extraction library or legacy extraction options remain", async () => {
    const source = await readFile(
      new URL("../src/lib/attachments.ts", import.meta.url),
      "utf8",
    );
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.dependencies.unpdf).toBeUndefined();
    expect(source.includes("extractText")).toBe(false);
    const connection = await protocolClient();
    try {
      const tools = await connection.client.listTools();
      const schemaText = JSON.stringify(tools.tools);
      expect(schemaText.includes("maxTextAttachments")).toBe(false);
      expect(schemaText.includes("searchAttachmentContents")).toBe(false);
      const rejected = await connection.client.callTool({
        name: "classroom_read_attachment",
        arguments: { fileId: "d", maxChars: 1000 },
      });
      expect(rejected.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });
});

describe("Workflow edge cases and HTTP authorization", () => {
  test("total byte budget limits combined downloads even when individual files fit", async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    mockFetch((url) =>
      url.searchParams.get("alt") === "media"
        ? new Response(bytes)
        : json({
            id: url.pathname.split("/").at(-1),
            mimeType: "application/pdf",
            size: String(bytes.length),
          }),
    );
    const refs = attachmentReferences(
      ["a", "b", "c"].map((id) => ({ driveFile: { id } })),
      { source: "teacher", sourceType: "material" },
    );
    const result = await collectOriginalFiles(context, refs, true, true);
    expect(result.resources.length).toBe(2);
    expect(result.totalBytes).toBe(8 * 1024 * 1024);
    expect(result.files[2]?.delivery).toBe("drive_mcp");
    expect(result.files[2]?.reason).toContain("budget");
  });
  test("selected course IDs retrieve metadata using Google's id parameter", async () => {
    mockFetch((url) => {
      if (url.pathname === "/v1/courses/selected")
        return json({ id: "selected", name: "Selected" });
      if (url.pathname.endsWith("/courseWork")) return json({ courseWork: [] });
      if (url.pathname.endsWith("/studentSubmissions"))
        return json({ studentSubmissions: [] });
      if (url.pathname.endsWith("/topics")) return json({ topic: [] });
      return json({});
    });
    const result = await overview(context, {
      ...options,
      courseIds: ["selected"],
      includePosts: false,
    });
    expect(result.partial).toBe(false);
    expect(result.courses[0]?.sources.course.data[0]?.name).toBe("Selected");
  });
  test("course file references follow assignment/date/status selection", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/courseWork"))
        return json({
          courseWork: [
            {
              id: "old",
              courseId: "c",
              dueDate: { year: 2025, month: 1, day: 1 },
              materials: [{ driveFile: { driveFile: { id: "old-file" } } }],
            },
            {
              id: "new",
              courseId: "c",
              dueDate: { year: 2030, month: 1, day: 1 },
              materials: [{ driveFile: { driveFile: { id: "new-file" } } }],
            },
          ],
        });
      if (url.pathname.endsWith("/studentSubmissions"))
        return json({ studentSubmissions: [] });
      return json({});
    });
    const bundle = await courseBundle(
      context,
      "c",
      { ...options, includePosts: false, from: "2029-01-01T00:00:00Z" },
      300000,
    );
    expect(bundle.assignments.map((item) => item.id)).toEqual(["new"]);
    expect(
      bundle.attachments.map((ref) =>
        ref.attachment.kind === "drive" ? ref.attachment.id : "other",
      ),
    ).toEqual(["new-file"]);
    expect(bundle.sources.work.data.length).toBe(2);
  });
  test("completed multi-page sources do not retain obsolete continuation", async () => {
    mockFetch((url) =>
      url.searchParams.get("pageToken")
        ? json({ courses: [{ id: "second" }] })
        : json({ courses: [{ id: "first" }], nextPageToken: "second" }),
    );
    const result = await listSource(
      context,
      "classroom.courses.list",
      "courses",
      {},
      { maxItems: 10, maxChars: 10000 },
    );
    expect(result.data.length).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.continuation).toBeUndefined();
  });
  test("successful turn-in is verified, with no implicit reclaim", async () => {
    let turnedIn = false;
    let turnInCalls = 0;
    mockFetch((url) => {
      if (url.pathname.endsWith(":turnIn")) {
        turnedIn = true;
        turnInCalls++;
        return json({});
      }
      const submission = {
        id: "s",
        courseWorkType: "ASSIGNMENT",
        state: turnedIn ? "TURNED_IN" : "CREATED",
      };
      return json(
        url.pathname.endsWith("/studentSubmissions")
          ? { studentSubmissions: [submission] }
          : submission,
      );
    });
    const result = await submitAssignment(context, {
      courseId: "c",
      courseWorkId: "w",
      addAttachments: [],
      turnIn: true,
    });
    expect(result.success).toBe(true);
    expect(result.submission?.state).toBe("TURNED_IN");
    expect(turnInCalls).toBe(1);
    const repeated = await submitAssignment(context, {
      courseId: "c",
      courseWorkId: "w",
      addAttachments: [],
      turnIn: true,
    });
    expect(repeated.success).toBe(true);
    expect(turnInCalls).toBe(1);
  });
  test("OAuth callback captures scopes actually granted by Google", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long";
    process.env.APP_ORIGIN = "https://classroom.example.com";
    process.env.GOOGLE_CLIENT_ID = "test-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    const { seal, unseal } = await import("../src/lib/crypto");
    const { GET } = await import("../src/app/oauth/google/callback/route");
    const state = await seal(
      "google-oauth-state",
      {
        clientId: "client",
        redirectUri: "https://client.example.com/callback",
        codeChallenge: "challenge",
        scopes: ["mcp"],
        resource: "https://classroom.example.com/mcp",
      },
      300,
    );
    mockFetch((url) =>
      url.hostname === "oauth2.googleapis.com"
        ? json({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "granted-one granted-two",
          })
        : json({
            sub: "sub",
            email: "student@example.com",
            email_verified: true,
          }),
    );
    const response = await GET(
      new Request(
        `https://classroom.example.com/oauth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(response.status).toBe(307);
    const code = new URL(
      response.headers.get("Location") ?? "",
    ).searchParams.get("code");
    expect(code).toBeTruthy();
    const payload = await unseal<{ googleScopes: string[] }>(
      code ?? "",
      "mcp-authorization-code",
    );
    expect(payload.googleScopes).toEqual(["granted-one", "granted-two"]);
  });
  test("actual MCP HTTP endpoint challenges missing bearer and serves authorized tools/list", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long";
    process.env.APP_ORIGIN = "https://classroom.example.com";
    const { POST } = await import("../src/app/mcp/route");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const headers = {
      Host: "classroom.example.com",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    };
    const denied = await POST(
      new Request("https://classroom.example.com/mcp", {
        method: "POST",
        headers,
        body,
      }),
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata",
    );
    const access = await issueMcpAccessToken({
      clientId: "test-client",
      googleSub: "sub",
      googleEmail: "student@example.com",
      scopes: ["mcp"],
      googleScopes: context.scopes,
      googleAccessToken: "access",
    });
    const response = await POST(
      new Request("https://classroom.example.com/mcp", {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${access.token}` },
        body,
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("classroom_courses_list");
    expect(text).toContain("classroom_submit_assignment");
    expect(text).not.toContain("test-google-secret");
  });
  test("authorized HTTP gzip preserves original PDF resource bytes", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long";
    process.env.APP_ORIGIN = "https://classroom.example.com";
    const { POST } = await import("../src/app/mcp/route");
    const pdf = Buffer.from(
      "%PDF-1.7\noriginal binary bytes\u0000\u00ff\n%%EOF",
    );
    mockFetch((url) =>
      url.searchParams.get("alt") === "media"
        ? new Response(pdf, { headers: { "Content-Type": "application/pdf" } })
        : json({
            id: "pdf",
            name: "original.pdf",
            mimeType: "application/pdf",
            size: String(pdf.length),
          }),
    );
    const access = await issueMcpAccessToken({
      clientId: "test-client",
      googleSub: "sub",
      googleEmail: "student@example.com",
      scopes: ["mcp"],
      googleScopes: context.scopes,
      googleAccessToken: "access",
    });
    const response = await POST(
      new Request("https://classroom.example.com/mcp", {
        method: "POST",
        headers: {
          Host: "classroom.example.com",
          Authorization: `Bearer ${access.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Accept-Encoding": "gzip",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "classroom_read_attachment",
            arguments: { fileId: "pdf" },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const decoded = gunzipSync(
      Buffer.from(await response.arrayBuffer()),
    ).toString();
    const payload = JSON.parse(
      decoded.startsWith("{")
        ? decoded
        : (decoded
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? ""),
    );
    expect(payload.result.isError).not.toBe(true);
    const resource = payload.result.content.find(
      (item: { type: string }) => item.type === "resource",
    ).resource;
    expect(resource.mimeType).toBe("application/pdf");
    const restored = Buffer.from(resource.blob, "base64");
    expect(restored.equals(pdf)).toBe(true);
    expect(createHash("sha256").update(restored).digest("hex")).toBe(
      createHash("sha256").update(pdf).digest("hex"),
    );
  });
});
