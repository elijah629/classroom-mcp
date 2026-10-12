import type {
  AuthInfo,
  BlobResourceContents,
} from "@modelcontextprotocol/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { collectOriginalFiles, readOriginalFile } from "./attachments";
import {
  googleContext,
  registerClassroomTools,
  toolError,
  toolResult,
} from "./classroom-api";
import { config } from "./config";
import {
  assignmentBundle,
  courseBundle,
  overview,
  submitAssignment,
} from "./workflows";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const defaults = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  maxItemsPerSource: z.number().int().min(1).max(100).default(50),
  maxCourses: z.number().int().min(1).max(30).default(10),
  includePosts: z.boolean().default(true),
  includeArchived: z.boolean().default(false),
  includeNoDue: z.boolean().default(true),
  statuses: z
    .array(
      z.enum([
        "upcoming",
        "missing",
        "turned_in",
        "returned",
        "reclaimed",
        "no_due",
        "unknown",
      ]),
    )
    .optional(),
  courseIds: z.array(z.string().min(1)).min(1).max(30).optional(),
};
const fileOptions = {
  includeFiles: z
    .boolean()
    .default(false)
    .describe(
      "Fetch original stored files as embedded binary resources. Google-native files and unsupported/over-budget files are handed to Drive MCP.",
    ),
  clientSupportsBinaryResources: z
    .boolean()
    .default(true)
    .describe(
      "Set false if this client cannot expose original embedded binary resources to the agent; use returned Drive IDs/URLs instead.",
    ),
};
function withResources(
  data: Record<string, unknown>,
  resources: BlobResourceContents[] = [],
) {
  const result = toolResult(data);
  return {
    ...result,
    content: [
      ...result.content,
      ...resources.map((resource) => ({ type: "resource" as const, resource })),
    ],
  };
}
// A rare oversized single Google object can exceed source budgets through
// attachment references. Do not cut strings or silently return incomplete docs.
export function boundWorkflow(
  data: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (JSON.stringify(data).length <= config.maxWorkflowChars) return data;
  return {
    truncated: true,
    reason:
      "Workflow metadata exceeds response budget. No document text was extracted or shortened.",
    continuation: {
      tool,
      arguments: {
        ...args,
        includeFiles: false,
        maxItemsPerSource: Math.max(
          1,
          Math.floor(Number(args.maxItemsPerSource ?? 50) / 2),
        ),
        maxCourses: 1,
      },
    },
    courseId: args.courseId,
    courseWorkId: args.courseWorkId,
    note: "Use the independent Classroom get/list tools for full records, or reduce the workflow selection.",
  };
}
export function buildMcpServer(authInfo?: AuthInfo): McpServer {
  const server = new McpServer(
    { name: "google-classroom", version: "0.2.0" },
    {
      instructions:
        "Start with classroom_overview, classroom_search or classroom_assignment_context. Independent classroom_* methods cover the official API. Check partial/truncated/source errors and continuations. Attachments are original binary resources or Drive MCP handoffs, never extracted text. Google controls roles, scopes and project association; availability of a tool is not permission to execute it. Turn-in requires explicit agent/user intent; combined submission defaults to attachment-only.",
    },
  );
  registerClassroomTools(server, authInfo);
  server.registerResource(
    "classroom_original_file",
    new ResourceTemplate("classroom-drive://files/{fileId}", {
      list: undefined,
    }),
    {
      title: "Original Classroom Drive attachment",
      description:
        "Authenticated, bounded original bytes; no text extraction or implicit native-document export. Use Drive MCP when unavailable.",
    },
    async (_uri, variables) => {
      const value = variables.fileId;
      if (typeof value !== "string" || !value)
        throw new Error("Invalid fileId");
      const file = await readOriginalFile(
        googleContext(authInfo),
        value,
        Math.min(config.maxAttachmentBytes, config.maxAttachmentTotalBytes),
      );
      if (!file.resource) throw new Error(JSON.stringify(file));
      return { contents: [file.resource] };
    },
  );
  server.registerTool(
    "classroom_overview",
    {
      title: "Classes, assignments and my submission status",
      description:
        "Best first call for planning. Joins active classes, assignments, your submissions and optional posts. Date bounds filter assignment due dates and post timestamps. Original Google records remain in sources; bounded fetching can be partial. Inspect all continuation/error metadata. Does not download files.",
      inputSchema: z.strictObject(defaults),
      annotations: readOnly,
    },
    async (args) => {
      try {
        return toolResult(
          boundWorkflow(
            await overview(googleContext(authInfo), args),
            "classroom_overview",
            args,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "classroom_course_context",
    {
      title: "Course context and original attachments",
      description:
        "Joins course metadata, topics, coursework, your submissions, materials and announcements. Optional original-file bundle. Sources preserve Google fields; no attachment text extraction. Assignment views use due dates; posts use update/creation time.",
      inputSchema: z.strictObject({
        ...defaults,
        courseId: z.string().min(1),
        ...fileOptions,
      }),
      annotations: readOnly,
    },
    async (args) => {
      try {
        const context = googleContext(authInfo);
        const bundle = await courseBundle(
          context,
          args.courseId,
          args,
          config.maxWorkflowChars * 0.7,
        );
        const files = await collectOriginalFiles(
          context,
          bundle.attachments,
          args.includeFiles,
          args.clientSupportsBinaryResources,
        );
        const { resources, ...fileMetadata } = files;
        const data = boundWorkflow(
          { ...bundle, attachmentBundle: fileMetadata },
          "classroom_course_context",
          args,
        );
        return withResources(data, data.continuation ? [] : resources);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "classroom_assignment_context",
    {
      title: "Assignment, rubric, my submission and original files",
      description:
        "Fetches assignment, course, rubric and your submission in one call. Includes original stored attachment files by default, within download limits. Always returns Drive handoff IDs/URLs when possible. No extracted text. Google-native files go to Drive MCP.",
      inputSchema: z.strictObject({
        courseId: z.string().min(1),
        courseWorkId: z.string().min(1),
        ...fileOptions,
        includeFiles: z.boolean().default(true),
      }),
      annotations: readOnly,
    },
    async (args) => {
      try {
        const context = googleContext(authInfo);
        const bundle = await assignmentBundle(
          context,
          args.courseId,
          args.courseWorkId,
        );
        const { resources, ...files } = await collectOriginalFiles(
          context,
          bundle.attachments,
          args.includeFiles,
          args.clientSupportsBinaryResources,
        );
        const data = boundWorkflow(
          { ...bundle, attachmentBundle: files },
          "classroom_assignment_context",
          args,
        );
        return withResources(data, data.continuation ? [] : resources);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "classroom_search",
    {
      title: "Find assignments, posts and attachment metadata",
      description:
        "Searches Classroom titles, descriptions, announcement text and attachment metadata, including your own submitted attachment metadata. Never searches or extracts file contents. Returns matching original Google records plus bounded-source coverage and continuations.",
      inputSchema: z.strictObject({
        ...defaults,
        query: z.string().trim().min(1),
        maxResults: z.number().int().min(1).max(100).default(30),
      }),
      annotations: readOnly,
    },
    async (args) => {
      try {
        const result = await overview(googleContext(authInfo), args);
        const matches: Record<string, unknown>[] = [];
        let matchesTruncated = false;
        const query = args.query.toLocaleLowerCase();
        for (const course of result.courses) {
          for (const [kind, source] of Object.entries(course.sources)) {
            if (
              !["work", "materials", "announcements", "submissions"].includes(
                kind,
              )
            )
              continue;
            const allowedAssignments = new Set(
              course.assignments.map((item) => item.id),
            );
            const allowedPosts = new Set(
              course.posts
                .filter(
                  (post) =>
                    post.kind ===
                    (kind === "materials" ? "material" : "announcement"),
                )
                .map((item) => item.id),
            );
            for (const item of source.data) {
              if (kind === "work" && !allowedAssignments.has(String(item.id)))
                continue;
              if (
                kind === "submissions" &&
                !allowedAssignments.has(String(item.courseWorkId))
              )
                continue;
              if (
                (kind === "materials" || kind === "announcements") &&
                !allowedPosts.has(item.id)
              )
                continue;
              const own = item.assignmentSubmission as
                | { attachments?: unknown[] }
                | undefined;
              const metadata = [
                ...(Array.isArray(item.materials) ? item.materials : []),
                ...(own?.attachments ?? []),
              ];
              const text = [
                item.title,
                item.description,
                item.text,
                JSON.stringify(metadata),
              ]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase();
              if (!text.includes(query)) continue;
              if (matches.length >= args.maxResults) {
                matchesTruncated = true;
                continue;
              }
              matches.push({ courseId: course.courseId, kind, item });
            }
          }
        }
        const coverage = result.courses.map((course) => ({
          courseId: course.courseId,
          sources: Object.fromEntries(
            Object.entries(course.sources).map(([key, source]) => [
              key,
              { ...source, data: undefined, fetchedCount: source.data.length },
            ]),
          ),
        }));
        return toolResult(
          boundWorkflow(
            {
              query: args.query,
              matches,
              coverage,
              courseDiscovery: { ...result.courseDiscovery, data: undefined },
              partial: result.partial,
              truncated: result.truncated || matchesTruncated,
              matchesTruncated,
              ...(matchesTruncated
                ? {
                    continuation: {
                      tool: "classroom_search",
                      arguments: {
                        ...args,
                        maxResults: Math.min(100, args.maxResults * 2),
                      },
                      note: "Narrow courseIds, query or dates when maxResults is already 100.",
                    },
                  }
                : {}),
              note: "Metadata-only search. No matches in bounded results does not establish absence from unfetched pages or file contents.",
            },
            "classroom_search",
            args,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "classroom_attachment_bundle",
    {
      title: "Collect assignment or class original attachments",
      description:
        "Collects teacher and student attachment references, deduplicates Drive downloads while preserving every source reference, and optionally fetches original files. Supply courseWorkId for one assignment; omit for class coursework, materials and announcements.",
      inputSchema: z.strictObject({
        ...defaults,
        courseId: z.string().min(1),
        courseWorkId: z.string().min(1).optional(),
        ...fileOptions,
        includeFiles: z.boolean().default(true),
      }),
      annotations: readOnly,
    },
    async (args) => {
      try {
        const context = googleContext(authInfo);
        const source = args.courseWorkId
          ? await assignmentBundle(context, args.courseId, args.courseWorkId)
          : await courseBundle(
              context,
              args.courseId,
              args,
              config.maxWorkflowChars * 0.7,
            );
        const { resources, ...files } = await collectOriginalFiles(
          context,
          source.attachments,
          args.includeFiles,
          args.clientSupportsBinaryResources,
        );
        const coverage = Object.fromEntries(
          Object.entries(source.sources).map(([key, value]) => [
            key,
            { ...value, data: undefined, fetchedCount: value.data.length },
          ]),
        );
        const data = boundWorkflow(
          {
            ...files,
            coverage,
            truncated: source.truncated,
            partial: source.partial,
          },
          "classroom_attachment_bundle",
          args,
        );
        return withResources(data, data.continuation ? [] : resources);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "classroom_read_attachment",
    {
      title: "Get an original Drive attachment",
      description:
        "Returns original bytes as an embedded binary resource, or a Drive MCP handoff with reason. Google-native files are handed off without implicit export. No text extraction. Set includeFiles=false for metadata/handoff only.",
      inputSchema: z.strictObject({
        fileId: z.string().min(1),
        ...fileOptions,
        includeFiles: z.boolean().default(true),
      }),
      annotations: readOnly,
    },
    async (args) => {
      try {
        const { resources, ...files } = await collectOriginalFiles(
          googleContext(authInfo),
          [
            {
              attachment: { kind: "drive", id: args.fileId },
              raw: { driveFile: { id: args.fileId } },
              source: "unspecified",
              sourceType: "file",
            },
          ],
          args.includeFiles,
          args.clientSupportsBinaryResources,
        );
        return withResources(files, resources);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const attachment = z.union([
    z.strictObject({ driveFile: z.strictObject({ id: z.string().min(1) }) }),
    z.strictObject({ link: z.strictObject({ url: z.url() }) }),
    z.strictObject({ youTubeVideo: z.strictObject({ id: z.string().min(1) }) }),
  ]);
  server.registerTool(
    "classroom_submit_assignment",
    {
      title: "Attach existing files and optionally turn in my assignment",
      description:
        "Finds your submission, adds specified existing Drive files/links/videos without removing existing attachments, optionally turns in, then verifies current state. turnIn defaults false. Does not upload files; use Drive MCP first. Google requires OAuth-project association; most unrelated teacher-created work may be denied. Returns each step and partial success. Never automatically reclaims or retries writes.",
      inputSchema: z.strictObject({
        courseId: z.string().min(1),
        courseWorkId: z.string().min(1),
        addAttachments: z.array(attachment).max(20).default([]),
        turnIn: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await submitAssignment(googleContext(authInfo), args);
        return {
          ...toolResult(result),
          ...(result.success ? {} : { isError: true }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  return server;
}
