import { createHash } from "node:crypto";
import {
  assignmentStatus,
  type ClassroomCourseWork,
  type ClassroomSubmission,
  dueDateIso,
  parseRange,
} from "./classroom";
import type { GoogleContext } from "./classroom-api";
import { config } from "./config";
import { mapConcurrent } from "./google-api";
import {
  getSource,
  type Item,
  listSource,
  type SourceResult,
  sourceCoverage,
} from "./workflows";

export interface PendingOptions {
  start?: string;
  end?: string;
  timeZone: string;
  includeOverdue: boolean;
  includeUndated: boolean;
  includeReturned: boolean;
  undatedSince?: string;
  courseIds?: string[];
  maxResults: number;
  cursor?: string;
}

export function studentStatus(state?: string): string {
  switch (state) {
    case "NEW":
      return "not_started";
    case "CREATED":
      return "in_progress_not_submitted";
    case "TURNED_IN":
      return "submitted";
    case "RETURNED":
      return "returned";
    case "RECLAIMED_BY_STUDENT":
      return "reclaimed";
    default:
      return "unknown";
  }
}

// Intl applies the selected zone's DST rules; no zone inferred from UTC.
export function localDeadline(utc: string | null, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  if (!utc) return { dueAtLocal: null, localDueDate: null };
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utc)).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const offset =
    parts.timeZoneName === "GMT"
      ? "+00:00"
      : parts.timeZoneName.replace("GMT", "");
  return {
    dueAtLocal: `${date}T${parts.hour}:${parts.minute}:${parts.second}${utc.slice(19, 23)}${offset}`,
    localDueDate: date,
  };
}

function project(keys: string[]) {
  return (item: Item): Item =>
    Object.fromEntries(
      keys.filter((key) => key in item).map((key) => [key, item[key]]),
    );
}
const workKeys = [
  "id",
  "courseId",
  "title",
  "dueDate",
  "dueTime",
  "alternateLink",
  "maxPoints",
  "creationTime",
  "updateTime",
  "topicId",
  "workType",
];
const submissionKeys = ["id", "courseWorkId", "state", "late", "assignedGrade"];

export async function pendingAssignments(
  context: GoogleContext,
  options: PendingOptions,
) {
  // Validate before upstream calls, including empty-result queries.
  localDeadline(null, options.timeZone);
  const range = parseRange(options.start, options.end);
  const undatedSince = options.undatedSince
    ? parseRange(options.undatedSince).fromMs
    : undefined;
  const { cursor, maxResults: _maxResults, ...filters } = options;
  const queryHash = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
  let offset = 0;
  let asOf = new Date().toISOString();
  if (cursor) {
    try {
      const saved = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        saved.queryHash !== queryHash ||
        !Number.isSafeInteger(saved.offset) ||
        saved.offset < 0 ||
        !Number.isFinite(Date.parse(saved.asOf))
      )
        throw Error();
      offset = saved.offset;
      asOf = saved.asOf;
    } catch {
      throw new Error(
        "Invalid cursor or changed filters; restart without cursor.",
      );
    }
  }
  const now = Date.parse(asOf);
  const scan = {
    maxItems: 10000,
    maxPages: 100,
    maxChars: config.maxWorkflowChars,
  };
  let discovery: SourceResult;
  if (options.courseIds?.length) {
    discovery = {
      data: [...new Set(options.courseIds)].map((id) => ({ id })),
      truncated: false,
    };
  } else {
    discovery = await listSource(
      context,
      "classroom.courses.list",
      "courses",
      {
        studentId: "me",
        courseStates: ["ACTIVE"],
      },
      { ...scan, maxItems: 100, project: project(["id", "name"]) },
    );
  }
  const assignments: Item[] = [];
  const coverageByCourse = [];
  for (const course of discovery.data) {
    const courseId = String(course.id);
    const [metadata, work, submissions] = await mapConcurrent(
      [
        () =>
          course.name
            ? Promise.resolve({
                data: [course],
                truncated: false,
              } as SourceResult)
            : getSource(context, "classroom.courses.get", {
                id: courseId,
                fields: "id,name",
              }),
        () =>
          listSource(
            context,
            "classroom.courses.courseWork.list",
            "courseWork",
            {
              courseId,
              courseWorkStates: ["PUBLISHED"],
              fields: `courseWork(${workKeys.join(",")}),nextPageToken`,
            },
            { ...scan, project: project(workKeys) },
          ),
        () =>
          listSource(
            context,
            "classroom.courses.courseWork.studentSubmissions.list",
            "studentSubmissions",
            {
              courseId,
              courseWorkId: "-",
              userId: "me",
              fields: `studentSubmissions(${submissionKeys.join(",")}),nextPageToken`,
            },
            { ...scan, project: project(submissionKeys) },
          ),
      ],
      config.workflowConcurrency,
      (task) => task(),
    );
    const coverage = sourceCoverage({ course: metadata, work, submissions });
    coverageByCourse.push({ courseId, ...coverage });
    const own = new Map(
      submissions.data.map((item) => [
        String(item.courseWorkId),
        item as unknown as ClassroomSubmission,
      ]),
    );
    // De-duplicate joins across pages by courseWorkId within each course.
    for (const item of new Map(
      work.data.map((item) => [String(item.id), item]),
    ).values()) {
      const record = item as unknown as ClassroomCourseWork;
      const submission = own.get(record.id);
      if (
        submission?.state === "TURNED_IN" ||
        (submission?.state === "RETURNED" && !options.includeReturned)
      )
        continue;
      const dueAtUtc = dueDateIso(record);
      if (!dueAtUtc) {
        if (!options.includeUndated) continue;
        if (
          undatedSince !== undefined &&
          ((!record.updateTime && !record.creationTime) ||
            !(
              Date.parse(record.updateTime ?? record.creationTime ?? "") >=
              undatedSince
            ))
        )
          continue;
      } else {
        const due = Date.parse(dueAtUtc);
        if (due > range.toMs) continue;
        if (!options.includeOverdue && due < now) continue;
        const lower = options.start ? range.fromMs : now;
        if (due < lower && !(options.includeOverdue && due < now)) continue;
      }
      assignments.push({
        courseId,
        courseName: metadata.data[0]?.name ?? course.name ?? null,
        courseWorkId: record.id,
        title: record.title,
        dueAtUtc,
        ...localDeadline(dueAtUtc, options.timeZone),
        dueDate: record.dueDate ?? null,
        dueTime: record.dueTime ?? null,
        dueTimeSpecified: !!record.dueTime,
        status: submission
          ? assignmentStatus(record, submission, now)
          : "unknown",
        rawSubmissionState: submission?.state ?? null,
        studentStatus: studentStatus(submission?.state),
        submissionId: submission?.id ?? null,
        late: submission?.late,
        assignedGrade: submission?.assignedGrade,
        maxPoints: record.maxPoints,
        assignmentUrl: record.alternateLink,
        creationTime: record.creationTime,
        updateTime: record.updateTime,
        topicId: record.topicId,
        workType: record.workType,
      });
    }
  }
  assignments.sort(
    (a, b) =>
      String(a.dueAtUtc ?? "9999").localeCompare(
        String(b.dueAtUtc ?? "9999"),
      ) ||
      String(a.courseId).localeCompare(String(b.courseId)) ||
      String(a.courseWorkId).localeCompare(String(b.courseWorkId)),
  );
  const discoveryCoverage = sourceCoverage({ courses: discovery });
  const hadErrors =
    discoveryCoverage.hadErrors || coverageByCourse.some((c) => c.hadErrors);
  const coverageComplete =
    discoveryCoverage.coverageComplete &&
    coverageByCourse.every((c) => c.coverageComplete);
  const resultLimitReached = offset + options.maxResults < assignments.length;
  return {
    asOf,
    timeZone: options.timeZone,
    filters,
    hadErrors,
    coverageComplete,
    unknownItemsPossible: !coverageComplete,
    resultLimitReached,
    resultsComplete: coverageComplete && !resultLimitReached,
    assignments: assignments.slice(offset, offset + options.maxResults),
    scannedMatchCount: assignments.length,
    coverageByCourse,
    courseDiscovery: discoveryCoverage.coverage.courses,
    nextCursor: resultLimitReached
      ? Buffer.from(
          JSON.stringify({
            queryHash,
            offset: offset + options.maxResults,
            asOf,
          }),
        ).toString("base64url")
      : null,
    note: "Compact metadata only; no file downloads. CREATED is not submitted. RETURNED does not imply revision needed. Missing submissions stay unknown. Undated work excluded by default. Date-only deadlines use 23:59:59 UTC as a filter/sort convention, not a specified due time. Cursor re-scans live data with fixed asOf; concurrent edits may shift pages. Incomplete scans require source continuations (methodId is the official API method ID; find its independent tool), not nextCursor. Source offsets skip items within that page.",
  };
}
