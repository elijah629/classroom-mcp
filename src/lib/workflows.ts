import { type AttachmentReference, attachmentReferences } from "./attachments";
import {
  type ClassroomCourseWork,
  type ClassroomSubmission,
  compactAssignment,
  inRange,
  parseRange,
} from "./classroom";
import {
  type ApiArguments,
  callClassroom,
  type GoogleContext,
} from "./classroom-api";
import { config } from "./config";
import { describeError, mapConcurrent } from "./google-api";

export type Item = Record<string, unknown>;
export interface Continuation {
  methodId: string;
  arguments: ApiArguments;
  offset?: number;
}
export interface SourceResult {
  data: Item[];
  error?: Record<string, unknown>;
  truncated: boolean;
  continuation?: Continuation;
}
export interface SourceOptions {
  maxItems: number;
  maxChars: number;
  maxPages?: number;
  project?: (item: Item) => Item;
}
export async function listSource(
  context: GoogleContext,
  methodId: string,
  field: string,
  args: ApiArguments,
  options: SourceOptions,
): Promise<SourceResult> {
  const result: SourceResult = { data: [], truncated: false };
  let pageToken: string | undefined;
  let chars = 0;
  try {
    for (let page = 0; page < (options.maxPages ?? 3); page++) {
      const argumentsForPage = {
        ...args,
        pageSize: Math.min(options.maxItems, 100),
        ...(pageToken ? { pageToken } : {}),
      };
      const response = await callClassroom(context, methodId, argumentsForPage);
      const items = Array.isArray(response[field])
        ? (response[field] as Item[])
        : [];
      for (let index = 0; index < items.length; index++) {
        const item = options.project
          ? options.project(items[index])
          : items[index];
        const size = JSON.stringify(item).length;
        if (
          result.data.length >= options.maxItems ||
          chars + size > options.maxChars
        ) {
          return {
            ...result,
            truncated: true,
            continuation: {
              methodId,
              arguments: argumentsForPage,
              offset: index,
            },
          };
        }
        result.data.push(item);
        chars += size;
      }
      pageToken =
        typeof response.nextPageToken === "string"
          ? response.nextPageToken
          : undefined;
      if (!pageToken) {
        delete result.continuation;
        return result;
      }
      result.continuation = {
        methodId,
        arguments: {
          ...args,
          pageSize: Math.min(options.maxItems, 100),
          pageToken,
        },
      };
      if (result.data.length >= options.maxItems)
        return { ...result, truncated: true };
    }
    return { ...result, truncated: true };
  } catch (error) {
    return {
      ...result,
      error: describeError(error),
      continuation: {
        methodId,
        arguments: { ...args, ...(pageToken ? { pageToken } : {}) },
      },
    };
  }
}
export async function getSource(
  context: GoogleContext,
  methodId: string,
  args: ApiArguments,
  maxChars = config.maxWorkflowChars,
): Promise<SourceResult> {
  try {
    const data = await callClassroom(context, methodId, args);
    if (JSON.stringify(data).length > maxChars)
      return {
        data: [],
        truncated: true,
        continuation: { methodId, arguments: args },
      };
    return { data: [data], truncated: false };
  } catch (error) {
    return {
      data: [],
      truncated: false,
      error: describeError(error),
      continuation: { methodId, arguments: args },
    };
  }
}
export function sourceCoverage(sources: Record<string, SourceResult>) {
  const hadErrors = Object.values(sources).some((source) => !!source.error);
  const coverageComplete = Object.values(sources).every(
    (source) => !source.error && !source.truncated,
  );
  return {
    hadErrors,
    coverageComplete,
    unknownItemsPossible: !coverageComplete,
    // Legacy partial means errors only, not truncation.
    partial: hadErrors,
    coverage: Object.fromEntries(
      Object.entries(sources).map(([key, source]) => [
        key,
        {
          fetchedCount: source.data.length,
          complete: !source.error && !source.truncated,
          truncated: source.truncated,
          error: source.error,
          continuation: source.continuation,
        },
      ]),
    ),
  };
}
export interface WorkflowOptions {
  from?: string;
  to?: string;
  maxItemsPerSource: number;
  maxCourses: number;
  includePosts: boolean;
  includeArchived: boolean;
  includeNoDue: boolean;
  statuses?: string[];
  courseIds?: string[];
}
function timeOf(item: Item): string | undefined {
  return typeof (item.updateTime ?? item.creationTime) === "string"
    ? String(item.updateTime ?? item.creationTime)
    : undefined;
}
export function bundleAttachments(
  sources: Record<string, SourceResult>,
  courseId: string,
): AttachmentReference[] {
  const refs: AttachmentReference[] = [];
  for (const item of sources.work?.data ?? [])
    refs.push(
      ...attachmentReferences(item.materials as unknown[] | undefined, {
        courseId,
        courseWorkId: String(item.id),
        itemId: String(item.id),
        source: "teacher",
        sourceType: "assignment",
      }),
    );
  for (const item of sources.submissions?.data ?? []) {
    const assignment = item.assignmentSubmission as
      | { attachments?: unknown[] }
      | undefined;
    refs.push(
      ...attachmentReferences(assignment?.attachments, {
        courseId,
        courseWorkId: String(item.courseWorkId),
        itemId: String(item.id),
        source: "student",
        sourceType: "submission",
      }),
    );
  }
  for (const [key, type] of [
    ["materials", "material"],
    ["announcements", "announcement"],
  ] as const) {
    for (const item of sources[key]?.data ?? [])
      refs.push(
        ...attachmentReferences(item.materials as unknown[] | undefined, {
          courseId,
          itemId: String(item.id),
          source: "teacher",
          sourceType: type,
        }),
      );
  }
  return refs;
}
export async function courseBundle(
  context: GoogleContext,
  courseId: string,
  options: WorkflowOptions,
  maxChars: number,
) {
  const courseArgs = { courseId };
  const requests: Array<[string, string, string | undefined, ApiArguments]> = [
    ["course", "classroom.courses.get", undefined, { id: courseId }],
    ["topics", "classroom.courses.topics.list", "topic", courseArgs],
    [
      "work",
      "classroom.courses.courseWork.list",
      "courseWork",
      { courseId, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc" },
    ],
    [
      "submissions",
      "classroom.courses.courseWork.studentSubmissions.list",
      "studentSubmissions",
      { courseId, courseWorkId: "-", userId: "me" },
    ],
  ];
  if (options.includePosts)
    requests.push(
      [
        "materials",
        "classroom.courses.courseWorkMaterials.list",
        "courseWorkMaterial",
        {
          courseId,
          courseWorkMaterialStates: ["PUBLISHED"],
          orderBy: "updateTime desc",
        },
      ],
      [
        "announcements",
        "classroom.courses.announcements.list",
        "announcements",
        {
          courseId,
          announcementStates: ["PUBLISHED"],
          orderBy: "updateTime desc",
        },
      ],
    );
  const sourceChars = Math.floor(maxChars / (requests.length + 2));
  const results = await mapConcurrent(
    requests,
    config.workflowConcurrency,
    async ([key, method, field, args]) =>
      [
        key,
        field
          ? await listSource(context, method, field, args, {
              maxItems: options.maxItemsPerSource,
              maxChars: sourceChars,
            })
          : await getSource(context, method, args, sourceChars),
      ] as const,
  );
  const sources = Object.fromEntries(results);
  const range = parseRange(options.from, options.to);
  const submissions = new Map(
    sources.submissions.data.map((item) => [
      item.courseWorkId,
      item as unknown as ClassroomSubmission,
    ]),
  );
  const assignments = sources.work.data
    .map((work) => {
      const compact = compactAssignment(
        work as unknown as ClassroomCourseWork,
        submissions.get(work.id),
      );
      if (
        !compact.submission &&
        (sources.submissions.error || sources.submissions.truncated)
      )
        return {
          ...compact,
          status: "unknown",
          statusNote:
            "Submission source incomplete; cannot infer missing work.",
        };
      return compact;
    })
    .filter((item) => {
      if (item.dueAt ? !inRange(item.dueAt, range) : !options.includeNoDue)
        return false;
      return (
        !options.statuses?.length || options.statuses.includes(item.status)
      );
    })
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  const posts: Array<Item & { kind: string }> = [
    ...(sources.materials?.data ?? []).map((item) => ({
      ...item,
      kind: "material",
    })),
    ...(sources.announcements?.data ?? []).map((item) => ({
      ...item,
      kind: "announcement",
    })),
  ].filter(
    (item) => (!options.from && !options.to) || inRange(timeOf(item), range),
  );
  // Raw source records keep every Google field. Joined views contain IDs/status;
  // avoid repeating descriptions, submissions and material objects in output.
  const joined = assignments.map((item) => ({
    id: item.id,
    courseId,
    title: item.title,
    dueAt: item.dueAt,
    status: item.status,
    submissionId: item.submission?.id,
    alternateLink: item.alternateLink,
  }));
  const postViews = posts.map((item) => ({
    id: item.id,
    kind: item.kind,
    updateTime: item.updateTime,
    creationTime: item.creationTime,
  }));
  const assignmentIds = new Set(joined.map((item) => item.id));
  const postIds = (kind: string) =>
    new Set(posts.filter((item) => item.kind === kind).map((item) => item.id));
  const materialIds = postIds("material");
  const announcementIds = postIds("announcement");
  const selectedSources = {
    ...sources,
    work: {
      ...sources.work,
      data: sources.work.data.filter((item) =>
        assignmentIds.has(String(item.id)),
      ),
    },
    submissions: {
      ...sources.submissions,
      data: sources.submissions.data.filter((item) =>
        assignmentIds.has(String(item.courseWorkId)),
      ),
    },
    materials: {
      ...sources.materials,
      data:
        sources.materials?.data.filter((item) => materialIds.has(item.id)) ??
        [],
    },
    announcements: {
      ...sources.announcements,
      data:
        sources.announcements?.data.filter((item) =>
          announcementIds.has(item.id),
        ) ?? [],
    },
  };
  return {
    courseId,
    ...sourceCoverage(sources),
    sources,
    assignments: joined,
    posts: postViews,
    attachments: bundleAttachments(selectedSources, courseId),
    truncated: Object.values(sources).some((source) => source.truncated),
    partial: Object.values(sources).some((source) => source.error),
  };
}
export async function overview(
  context: GoogleContext,
  options: WorkflowOptions,
) {
  parseRange(options.from, options.to);
  let courses: SourceResult;
  if (options.courseIds?.length) {
    const results = await mapConcurrent(
      options.courseIds.slice(0, options.maxCourses),
      config.workflowConcurrency,
      (courseId) =>
        getSource(
          context,
          "classroom.courses.get",
          { id: courseId },
          Math.floor(config.maxWorkflowChars / (options.maxCourses * 10)),
        ),
    );
    courses = {
      data: results.flatMap((result) => result.data),
      truncated:
        options.courseIds.length > options.maxCourses ||
        results.some((r) => r.truncated),
    };
    const errors = results.flatMap((result, index) =>
      result.error
        ? [{ courseId: options.courseIds?.[index], error: result.error }]
        : [],
    );
    if (errors.length) courses.error = { kind: "partial_courses", errors };
    if (options.courseIds.length > options.maxCourses)
      courses.continuation = {
        methodId: "classroom_overview",
        arguments: {
          ...options,
          courseIds: options.courseIds.slice(options.maxCourses),
        },
      };
  } else
    courses = await listSource(
      context,
      "classroom.courses.list",
      "courses",
      {
        studentId: "me",
        courseStates: options.includeArchived
          ? ["ACTIVE", "ARCHIVED"]
          : ["ACTIVE"],
      },
      {
        maxItems: options.maxCourses,
        maxChars: Math.floor(config.maxWorkflowChars / 10),
      },
    );
  // Course calls run sequentially; source requests within a course run concurrently.
  // Thus concurrency stays globally bounded even across many courses.
  const bundles = [];
  const perCourse = Math.floor(
    (config.maxWorkflowChars * 0.7) / Math.max(courses.data.length, 1),
  );
  for (const course of courses.data)
    bundles.push(
      await courseBundle(context, String(course.id), options, perCourse),
    );
  return {
    courses: bundles,
    courseDiscovery: courses,
    range: { from: options.from ?? null, to: options.to ?? null },
    filters: options,
    hadErrors: !!courses.error || bundles.some((b) => b.hadErrors),
    coverageComplete:
      !courses.error &&
      !courses.truncated &&
      bundles.every((b) => b.coverageComplete),
    unknownItemsPossible:
      !!courses.error ||
      courses.truncated ||
      bundles.some((b) => !b.coverageComplete),
    resultLimitReached: false,
    coverageByCourse: bundles.map((b) => ({
      courseId: b.courseId,
      coverageComplete: b.coverageComplete,
      sources: b.coverage,
    })),
    truncated: courses.truncated || bundles.some((b) => b.truncated),
    partial: !!courses.error || bundles.some((b) => b.partial),
    note: "Joined assignments/posts are filtered views. sources contain original Google records fetched within explicit limits; inspect errors and continuations before drawing conclusions.",
  };
}
export async function assignmentBundle(
  context: GoogleContext,
  courseId: string,
  courseWorkId: string,
) {
  const args = { courseId, courseWorkId };
  const budget = Math.floor(config.maxWorkflowChars / 6);
  const requests: Array<[string, () => Promise<SourceResult>]> = [
    [
      "course",
      () =>
        getSource(context, "classroom.courses.get", { id: courseId }, budget),
    ],
    [
      "work",
      () =>
        getSource(
          context,
          "classroom.courses.courseWork.get",
          { courseId, id: courseWorkId },
          budget,
        ),
    ],
    [
      "submissions",
      () =>
        listSource(
          context,
          "classroom.courses.courseWork.studentSubmissions.list",
          "studentSubmissions",
          { ...args, userId: "me" },
          { maxItems: 10, maxChars: budget },
        ),
    ],
    [
      "rubrics",
      () =>
        listSource(
          context,
          "classroom.courses.courseWork.rubrics.list",
          "rubrics",
          args,
          { maxItems: 10, maxChars: budget },
        ),
    ],
  ];
  const sources = Object.fromEntries(
    await mapConcurrent(
      requests,
      config.workflowConcurrency,
      async ([key, task]) => [key, await task()] as const,
    ),
  );
  return {
    courseId,
    courseWorkId,
    ...sourceCoverage(sources),
    sources,
    attachments: bundleAttachments(sources, courseId),
    truncated: Object.values(sources).some((s) => s.truncated),
    partial: Object.values(sources).some((s) => s.error),
  };
}
export interface SubmissionOptions {
  courseId: string;
  courseWorkId: string;
  addAttachments: unknown[];
  turnIn: boolean;
}
export async function submitAssignment(
  context: GoogleContext,
  options: SubmissionOptions,
) {
  const steps: Item[] = [];
  const args: ApiArguments = {
    courseId: options.courseId,
    courseWorkId: options.courseWorkId,
  };
  let submission: Item | undefined;
  let changed = false;
  try {
    const response = await callClassroom(
      context,
      "classroom.courses.courseWork.studentSubmissions.list",
      { ...args, userId: "me", pageSize: 10 },
    );
    const submissions = response.studentSubmissions as Item[] | undefined;
    if (submissions?.length !== 1 || response.nextPageToken)
      throw new Error(
        "Expected exactly one submission belonging to the authenticated student.",
      );
    submission = submissions[0];
    args.id = submission.id;
    steps.push({
      step: "find_submission",
      status: "success",
      submissionId: submission.id,
    });
    if (options.addAttachments.length) {
      const existing =
        (
          submission.assignmentSubmission as
            | { attachments?: unknown[] }
            | undefined
        )?.attachments ?? [];
      const identity = (value: unknown) => {
        const item = value as {
          driveFile?: { id?: string };
          link?: { url?: string };
          youTubeVideo?: { id?: string };
        };
        return item.driveFile?.id
          ? `drive:${item.driveFile.id}`
          : item.link?.url
            ? `link:${item.link.url}`
            : item.youTubeVideo?.id
              ? `youtube:${item.youTubeVideo.id}`
              : JSON.stringify(value);
      };
      const seen = new Set(existing.map(identity));
      const additions = options.addAttachments.filter((item) => {
        const key = identity(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (additions.length) {
        if (submission.courseWorkType !== "ASSIGNMENT")
          throw new Error("Attachments require ASSIGNMENT coursework.");
        submission = await callClassroom(
          context,
          "classroom.courses.courseWork.studentSubmissions.modifyAttachments",
          { ...args, body: { addAttachments: additions } },
        );
        changed = true;
      }
      steps.push({
        step: "add_attachments",
        status: additions.length ? "success" : "already_attached",
        addedCount: additions.length,
      });
    }
    if (options.turnIn) {
      if (submission?.state !== "TURNED_IN") {
        await callClassroom(
          context,
          "classroom.courses.courseWork.studentSubmissions.turnIn",
          { ...args, body: {} },
        );
        changed = true;
        steps.push({ step: "turn_in", status: "success" });
      } else steps.push({ step: "turn_in", status: "already_turned_in" });
    }
  } catch (error) {
    steps.push({
      step:
        steps.length === 0
          ? "find_submission"
          : options.addAttachments.length &&
              !steps.some((s) => s.step === "add_attachments")
            ? "add_attachments"
            : "turn_in",
      status: "failed",
      error: describeError(error),
    });
  }
  // Re-read even after a write error: state may have changed before a network failure.
  if (args.id) {
    try {
      submission = await callClassroom(
        context,
        "classroom.courses.courseWork.studentSubmissions.get",
        args,
      );
      steps.push({ step: "verify_submission", status: "success" });
    } catch (error) {
      steps.push({
        step: "verify_submission",
        status: "failed",
        error: describeError(error),
      });
    }
  }
  const failed = steps.some((step) => step.status === "failed");
  return {
    ...options,
    addAttachments: undefined,
    steps,
    submission,
    changed,
    success: !failed,
    partial: changed && failed,
    note: "No automatic reclaim, attachment removal, rollback or write retries. Google requires project association for modifyAttachments/turnIn; inspect step results.",
  };
}
