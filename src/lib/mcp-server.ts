import type { AuthInfo } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  type NormalizedAttachment,
  normalizeAttachments,
  readDriveAttachment,
} from "./attachments";
import {
  type ClassroomAnnouncement,
  type ClassroomCourseWork,
  type ClassroomCourseWorkMaterial,
  type ClassroomSubmission,
  compactAssignment,
  getCourse,
  getCourseWork,
  inRange,
  listAnnouncements,
  listCourses,
  listCourseWork,
  listCourseWorkMaterials,
  listMySubmissions,
  listRubrics,
  listTopics,
  parseRange,
} from "./classroom";
import { config } from "./config";
import { googleAccessTokenFromAuthInfo } from "./mcp-token";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as any,
  };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: "text" as const, text: `Google Classroom MCP error: ${message}` },
    ],
    isError: true,
  };
}

function requireAuth(authInfo?: AuthInfo): AuthInfo {
  if (!authInfo) throw new Error("Authentication context missing");
  return authInfo;
}

function submissionMap(submissions: ClassroomSubmission[]) {
  return new Map(submissions.map((s) => [s.courseWorkId, s]));
}

function itemTimestamp(
  item: ClassroomAnnouncement | ClassroomCourseWorkMaterial,
): string | undefined {
  return item.updateTime ?? item.creationTime;
}

function filterStreamItems<
  T extends ClassroomAnnouncement | ClassroomCourseWorkMaterial,
>(items: T[], from?: string, to?: string): T[] {
  if (!from && !to) return items;
  const range = parseRange(from, to);
  return items.filter((item) => inRange(itemTimestamp(item), range));
}

async function enrichAttachments(
  accessToken: string,
  raw: unknown[] | undefined,
  mode: "metadata" | "text",
  maxTextAttachments: number,
  maxChars: number,
) {
  const normalized = normalizeAttachments(raw);
  if (mode !== "text") return normalized;

  let remaining = maxTextAttachments;
  const enriched: Array<NormalizedAttachment & { extracted?: unknown }> = [];
  for (const attachment of normalized) {
    if (attachment.kind === "drive" && remaining > 0) {
      remaining--;
      try {
        enriched.push({
          ...attachment,
          extracted: await readDriveAttachment(
            accessToken,
            attachment.id,
            maxChars,
          ),
        });
      } catch (error) {
        enriched.push({
          ...attachment,
          extracted: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } else {
      enriched.push(attachment);
    }
  }
  return enriched;
}

function searchableText(item: any): string {
  const attachmentText = normalizeAttachments(item.materials ?? [])
    .map((a) => {
      if (a.kind === "drive") return `${a.title ?? ""} ${a.url ?? ""}`;
      if (a.kind === "link") return `${a.title ?? ""} ${a.url}`;
      if (a.kind === "youtube") return `${a.title ?? ""} ${a.url ?? ""}`;
      if (a.kind === "form") return `${a.title ?? ""} ${a.formUrl ?? ""}`;
      return "title" in a ? String(a.title ?? "") : "";
    })
    .join(" ");
  return [item.title, item.description, item.text, attachmentText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function contextSnippet(text: string, query: string, radius = 260): string {
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function buildMcpServer(authInfo?: AuthInfo): McpServer {
  const server = new McpServer({
    name: "google-classroom",
    version: "0.1.0",
  });

  server.registerTool(
    "classroom_overview",
    {
      title: "Google Classroom overview",
      description:
        "Best first call for planning. Joins active courses, coursework, the authenticated student's own submissions, plus recent announcements and class materials in one request. Date bounds apply to assignment due dates and post update times. Use this for 'what is due?', 'what did teachers post?', and weekly planning before calling deeper tools.",
      inputSchema: z.object({
        from: z
          .string()
          .datetime()
          .optional()
          .describe("Inclusive ISO-8601 due-date lower bound."),
        to: z
          .string()
          .datetime()
          .optional()
          .describe("Inclusive ISO-8601 due-date upper bound."),
        courseIds: z.array(z.string()).max(30).optional(),
        statuses: z
          .array(
            z.enum([
              "upcoming",
              "missing",
              "turned_in",
              "returned",
              "reclaimed",
              "no_due",
            ]),
          )
          .optional(),
        includeNoDue: z.boolean().default(false),
        includeArchived: z.boolean().default(false),
        includePosts: z
          .boolean()
          .default(true)
          .describe(
            "Also return announcements and class materials. Date bounds apply to their update/creation time.",
          ),
        maxAssignmentsPerCourse: z.number().int().min(1).max(100).default(50),
        maxPostsPerCourse: z.number().int().min(1).max(100).default(30),
      }),
      annotations: readOnly,
    },
    async ({
      from,
      to,
      courseIds,
      statuses,
      includeNoDue,
      includeArchived,
      includePosts,
      maxAssignmentsPerCourse,
      maxPostsPerCourse,
    }) => {
      try {
        const auth = requireAuth(authInfo);
        const accessToken = googleAccessTokenFromAuthInfo(auth);
        let courses = await listCourses(accessToken, includeArchived);
        if (courseIds?.length) {
          const allowed = new Set(courseIds);
          courses = courses.filter((c) => allowed.has(c.id));
        }
        const range = parseRange(from, to);
        const statusFilter = statuses?.length ? new Set(statuses) : undefined;

        const courseResults = await Promise.all(
          courses.map(async (course) => {
            const [work, submissions, materials, announcements] =
              await Promise.all([
                listCourseWork(accessToken, course.id),
                listMySubmissions(accessToken, course.id),
                includePosts
                  ? listCourseWorkMaterials(accessToken, course.id)
                  : Promise.resolve([]),
                includePosts
                  ? listAnnouncements(accessToken, course.id)
                  : Promise.resolve([]),
              ]);
            const submissionsByWork = submissionMap(submissions);
            const assignments = work
              .map((item) =>
                compactAssignment(item, submissionsByWork.get(item.id)),
              )
              .filter((item) => {
                if (item.dueAt) {
                  if (!inRange(item.dueAt, range)) return false;
                } else if (!includeNoDue) {
                  return false;
                }
                return !statusFilter || statusFilter.has(item.status);
              })
              .sort((a, b) =>
                (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"),
              )
              .slice(0, maxAssignmentsPerCourse);

            const counts = assignments.reduce<Record<string, number>>(
              (acc, item) => {
                acc[item.status] = (acc[item.status] ?? 0) + 1;
                return acc;
              },
              {},
            );

            const posts = includePosts
              ? [
                  ...filterStreamItems(materials, from, to).map((item) => ({
                    kind: "material" as const,
                    id: item.id,
                    title: item.title,
                    description: item.description,
                    topicId: item.topicId,
                    scheduledTime: item.scheduledTime,
                    creationTime: item.creationTime,
                    updateTime: item.updateTime,
                    alternateLink: item.alternateLink,
                    attachments: normalizeAttachments(item.materials),
                  })),
                  ...filterStreamItems(announcements, from, to).map((item) => ({
                    kind: "announcement" as const,
                    id: item.id,
                    text: item.text,
                    scheduledTime: item.scheduledTime,
                    creationTime: item.creationTime,
                    updateTime: item.updateTime,
                    alternateLink: item.alternateLink,
                    attachments: normalizeAttachments(item.materials),
                  })),
                ]
                  .sort((a, b) =>
                    String(b.updateTime ?? b.creationTime ?? "").localeCompare(
                      String(a.updateTime ?? a.creationTime ?? ""),
                    ),
                  )
                  .slice(0, maxPostsPerCourse)
              : [];

            return {
              course: {
                id: course.id,
                name: course.name,
                section: course.section,
                room: course.room,
                alternateLink: course.alternateLink,
              },
              counts,
              assignments,
              posts,
            };
          }),
        );

        return ok({
          authenticatedGoogleAccount: auth.extra?.googleEmail,
          range: { from: from ?? null, to: to ?? null },
          courses: courseResults,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "classroom_course_context",
    {
      title: "Full course context",
      description:
        "Fetches one course as a joined context bundle: course metadata, topics, assignments + your submissions, class materials, announcements, and normalized attachments. Set attachmentMode='text' when the model needs syllabus/document contents; text extraction is capped for latency and token safety.",
      inputSchema: z.object({
        courseId: z.string(),
        from: z
          .string()
          .datetime()
          .optional()
          .describe(
            "Filter assignment due dates and stream-item update times.",
          ),
        to: z.string().datetime().optional(),
        attachmentMode: z.enum(["metadata", "text"]).default("metadata"),
        maxTextAttachments: z.number().int().min(0).max(20).default(6),
        maxCharsPerAttachment: z
          .number()
          .int()
          .min(1000)
          .max(config.maxAttachmentTextChars)
          .default(30000),
      }),
      annotations: readOnly,
    },
    async ({
      courseId,
      from,
      to,
      attachmentMode,
      maxTextAttachments,
      maxCharsPerAttachment,
    }) => {
      try {
        const auth = requireAuth(authInfo);
        const accessToken = googleAccessTokenFromAuthInfo(auth);
        const [course, topics, work, submissions, materials, announcements] =
          await Promise.all([
            getCourse(accessToken, courseId),
            listTopics(accessToken, courseId),
            listCourseWork(accessToken, courseId),
            listMySubmissions(accessToken, courseId),
            listCourseWorkMaterials(accessToken, courseId),
            listAnnouncements(accessToken, courseId),
          ]);
        const submissionsByWork = submissionMap(submissions);
        const range = parseRange(from, to);

        const filteredWork = work.filter((item) => {
          if (!from && !to) return true;
          const compact = compactAssignment(
            item,
            submissionsByWork.get(item.id),
          );
          return compact.dueAt
            ? inRange(compact.dueAt, range)
            : inRange(item.updateTime, range);
        });
        const filteredMaterials = filterStreamItems(materials, from, to);
        const filteredAnnouncements = filterStreamItems(
          announcements,
          from,
          to,
        );

        let extractionBudget = maxTextAttachments;
        const enrich = async (raw: unknown[] | undefined) => {
          const use =
            attachmentMode === "text" ? Math.max(0, extractionBudget) : 0;
          const result = await enrichAttachments(
            accessToken,
            raw,
            attachmentMode,
            use,
            maxCharsPerAttachment,
          );
          if (attachmentMode === "text") {
            const used = result.filter(
              (a: any) => a.kind === "drive" && a.extracted,
            ).length;
            extractionBudget = Math.max(0, extractionBudget - used);
          }
          return result;
        };

        // Spend the optional text-extraction budget on class materials first. Syllabi,
        // policies, unit handouts, and reference documents are usually posted there; a
        // specific assignment can be expanded separately with classroom_assignment_context.
        const classMaterials = [];
        for (const item of filteredMaterials) {
          classMaterials.push({
            id: item.id,
            title: item.title,
            description: item.description,
            topicId: item.topicId,
            state: item.state,
            assigneeMode: item.assigneeMode,
            scheduledTime: item.scheduledTime,
            creationTime: item.creationTime,
            updateTime: item.updateTime,
            alternateLink: item.alternateLink,
            attachments: await enrich(item.materials),
          });
        }

        const classAnnouncements = [];
        for (const item of filteredAnnouncements) {
          classAnnouncements.push({
            id: item.id,
            text: item.text,
            state: item.state,
            assigneeMode: item.assigneeMode,
            scheduledTime: item.scheduledTime,
            creationTime: item.creationTime,
            updateTime: item.updateTime,
            alternateLink: item.alternateLink,
            attachments: await enrich(item.materials),
          });
        }

        const assignments = [];
        for (const item of filteredWork) {
          const compact = compactAssignment(
            item,
            submissionsByWork.get(item.id),
          );
          assignments.push({
            ...compact,
            materials: await enrich(item.materials),
            submission: compact.submission
              ? {
                  ...compact.submission,
                  attachments: await enrich(
                    submissionsByWork.get(item.id)?.assignmentSubmission
                      ?.attachments,
                  ),
                }
              : null,
          });
        }

        return ok({
          course,
          topics,
          assignments,
          materials: classMaterials,
          announcements: classAnnouncements,
          attachmentTextBudgetRemaining: extractionBudget,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "classroom_assignment_context",
    {
      title: "Assignment details and submission",
      description:
        "Fetch one assignment and join it with your own submission, grade/state, teacher-provided materials, and your submitted attachments. Use after classroom_overview when one assignment needs close inspection.",
      inputSchema: z.object({
        courseId: z.string(),
        courseWorkId: z.string(),
        attachmentMode: z.enum(["metadata", "text"]).default("metadata"),
        maxTextAttachments: z.number().int().min(0).max(20).default(8),
        maxCharsPerAttachment: z
          .number()
          .int()
          .min(1000)
          .max(config.maxAttachmentTextChars)
          .default(40000),
      }),
      annotations: readOnly,
    },
    async ({
      courseId,
      courseWorkId,
      attachmentMode,
      maxTextAttachments,
      maxCharsPerAttachment,
    }) => {
      try {
        const auth = requireAuth(authInfo);
        const accessToken = googleAccessTokenFromAuthInfo(auth);
        const [course, work, submissions, rubrics] = await Promise.all([
          getCourse(accessToken, courseId),
          getCourseWork(accessToken, courseId, courseWorkId),
          listMySubmissions(accessToken, courseId),
          listRubrics(accessToken, courseId, courseWorkId),
        ]);
        const submission = submissions.find(
          (s) => s.courseWorkId === courseWorkId,
        );
        const compact = compactAssignment(work, submission);
        let extractionBudget = maxTextAttachments;
        const enrich = async (raw: unknown[] | undefined) => {
          const use = attachmentMode === "text" ? extractionBudget : 0;
          const result = await enrichAttachments(
            accessToken,
            raw,
            attachmentMode,
            use,
            maxCharsPerAttachment,
          );
          if (attachmentMode === "text") {
            extractionBudget = Math.max(
              0,
              extractionBudget -
                result.filter((a: any) => a.kind === "drive" && a.extracted)
                  .length,
            );
          }
          return result;
        };

        return ok({
          course: { id: course.id, name: course.name, section: course.section },
          rubrics,
          assignment: {
            ...compact,
            materials: await enrich(work.materials),
            submission: compact.submission
              ? {
                  ...compact.submission,
                  attachments: await enrich(
                    submission?.assignmentSubmission?.attachments,
                  ),
                }
              : null,
          },
          attachmentTextBudgetRemaining: extractionBudget,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "classroom_search",
    {
      title: "Search Classroom posts and files",
      description:
        "Search across assignment titles/descriptions, class materials, announcements, teacher attachments, and your own submitted attachment titles/URLs. Optionally search bounded Drive attachment contents too. Date filters apply to due/update time. Use this to locate syllabi, policies, old handouts, submitted work, or a vaguely remembered instruction.",
      inputSchema: z.object({
        query: z.string().min(1),
        courseIds: z.array(z.string()).max(30).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        includeArchived: z.boolean().default(false),
        searchAttachmentContents: z.boolean().default(false),
        maxAttachmentReads: z.number().int().min(1).max(20).default(8),
        maxCharsPerAttachment: z
          .number()
          .int()
          .min(1000)
          .max(config.maxAttachmentTextChars)
          .default(30000),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: readOnly,
    },
    async ({
      query,
      courseIds,
      from,
      to,
      includeArchived,
      searchAttachmentContents,
      maxAttachmentReads,
      maxCharsPerAttachment,
      limit,
    }) => {
      try {
        const auth = requireAuth(authInfo);
        const accessToken = googleAccessTokenFromAuthInfo(auth);
        let courses = await listCourses(accessToken, includeArchived);
        if (courseIds?.length) {
          const set = new Set(courseIds);
          courses = courses.filter((c) => set.has(c.id));
        }
        const q = query.toLowerCase();
        const range = parseRange(from, to);
        const results: any[] = [];
        const attachmentSources = new Map<
          string,
          {
            attachment: Extract<NormalizedAttachment, { kind: "drive" }>;
            sources: any[];
          }
        >();

        const rememberAttachments = (
          course: any,
          kind: string,
          item: any,
          rawAttachments: unknown[] | undefined = item.materials,
        ) => {
          for (const attachment of normalizeAttachments(rawAttachments)) {
            if (attachment.kind !== "drive") continue;
            const existing = attachmentSources.get(attachment.id);
            const source = {
              kind,
              course: { id: course.id, name: course.name },
              id: item.id,
              title: item.title,
              alternateLink: item.alternateLink,
              updateTime: item.updateTime,
            };
            if (existing) existing.sources.push(source);
            else
              attachmentSources.set(attachment.id, {
                attachment,
                sources: [source],
              });
          }
        };

        await Promise.all(
          courses.map(async (course) => {
            const [work, materials, announcements, submissions] =
              await Promise.all([
                listCourseWork(accessToken, course.id),
                listCourseWorkMaterials(accessToken, course.id),
                listAnnouncements(accessToken, course.id),
                listMySubmissions(accessToken, course.id),
              ]);
            const submissionsByWork = submissionMap(submissions);
            for (const item of work) {
              const submission = submissionsByWork.get(item.id);
              const dueAt = compactAssignment(item, submission).dueAt;
              const time = dueAt ?? item.updateTime;
              if ((from || to) && !inRange(time, range)) continue;
              if (searchAttachmentContents) {
                rememberAttachments(course, "assignment", item);
                rememberAttachments(
                  course,
                  "submission",
                  {
                    id: submission?.id,
                    title: item.title,
                    alternateLink: submission?.alternateLink,
                    updateTime: submission?.updateTime,
                  },
                  submission?.assignmentSubmission?.attachments,
                );
              }
              const submittedAttachments = normalizeAttachments(
                submission?.assignmentSubmission?.attachments,
              );
              const submissionAttachmentText = submittedAttachments
                .map((attachment) => {
                  if (attachment.kind === "drive")
                    return `${attachment.title ?? ""} ${attachment.url ?? ""}`;
                  if (attachment.kind === "link")
                    return `${attachment.title ?? ""} ${attachment.url}`;
                  if (attachment.kind === "youtube")
                    return `${attachment.title ?? ""} ${attachment.url ?? ""}`;
                  if (attachment.kind === "form")
                    return `${attachment.title ?? ""} ${attachment.formUrl ?? ""}`;
                  return "title" in attachment
                    ? String(attachment.title ?? "")
                    : "";
                })
                .join(" ")
                .toLowerCase();

              if (
                searchableText(item).includes(q) ||
                submissionAttachmentText.includes(q)
              ) {
                results.push({
                  kind: "assignment",
                  course: { id: course.id, name: course.name },
                  id: item.id,
                  title: item.title,
                  description: item.description,
                  dueAt,
                  updateTime: item.updateTime,
                  alternateLink: item.alternateLink,
                  attachments: normalizeAttachments(item.materials),
                  submission: submission
                    ? {
                        id: submission.id,
                        state: submission.state,
                        updateTime: submission.updateTime,
                        alternateLink: submission.alternateLink,
                        attachments: submittedAttachments,
                      }
                    : null,
                });
              }
            }
            for (const item of materials) {
              if ((from || to) && !inRange(itemTimestamp(item), range))
                continue;
              if (searchAttachmentContents)
                rememberAttachments(course, "material", item);
              if (searchableText(item).includes(q)) {
                results.push({
                  kind: "material",
                  course: { id: course.id, name: course.name },
                  id: item.id,
                  title: item.title,
                  description: item.description,
                  updateTime: item.updateTime,
                  alternateLink: item.alternateLink,
                  attachments: normalizeAttachments(item.materials),
                });
              }
            }
            for (const item of announcements) {
              if ((from || to) && !inRange(itemTimestamp(item), range))
                continue;
              if (searchAttachmentContents)
                rememberAttachments(course, "announcement", item);
              if (searchableText(item).includes(q)) {
                results.push({
                  kind: "announcement",
                  course: { id: course.id, name: course.name },
                  id: item.id,
                  text: item.text,
                  updateTime: item.updateTime,
                  alternateLink: item.alternateLink,
                  attachments: normalizeAttachments(item.materials),
                });
              }
            }
          }),
        );

        let attachmentReads = 0;
        if (searchAttachmentContents) {
          for (const [fileId, candidate] of attachmentSources) {
            if (attachmentReads >= maxAttachmentReads) break;
            attachmentReads++;
            try {
              const extracted = await readDriveAttachment(
                accessToken,
                fileId,
                maxCharsPerAttachment,
              );
              if (extracted.text?.toLowerCase().includes(q)) {
                results.push({
                  kind: "attachment_content",
                  fileId,
                  title: candidate.attachment.title ?? extracted.file.name,
                  file: extracted.file,
                  extraction: extracted.extraction,
                  snippet: contextSnippet(extracted.text, query),
                  sources: candidate.sources,
                });
              }
            } catch {
              // Search is best-effort; one unsupported/unreadable file should not fail the whole Classroom query.
            }
          }
        }

        results.sort((a, b) =>
          String(b.updateTime ?? b.dueAt ?? "").localeCompare(
            String(a.updateTime ?? a.dueAt ?? ""),
          ),
        );
        return ok({
          query,
          results: results.slice(0, limit),
          totalMatchesBeforeLimit: results.length,
          attachmentContentSearch: searchAttachmentContents
            ? {
                filesConsidered: attachmentSources.size,
                filesRead: attachmentReads,
                cappedAt: maxAttachmentReads,
              }
            : { enabled: false },
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "classroom_read_attachment",
    {
      title: "Read a Classroom Drive attachment",
      description:
        "Read the actual text of a Drive attachment found in Classroom. Handles Google Docs, Sheets, Slides, PDFs, and plain-text files. Use this for syllabus/policy/handout questions after another tool returns a Drive file ID.",
      inputSchema: z.object({
        fileId: z.string(),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(config.maxAttachmentTextChars)
          .default(60000),
      }),
      annotations: readOnly,
    },
    async ({ fileId, maxChars }) => {
      try {
        const auth = requireAuth(authInfo);
        const accessToken = googleAccessTokenFromAuthInfo(auth);
        return ok(await readDriveAttachment(accessToken, fileId, maxChars));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
