export interface ClassroomCourse {
  id: string;
  name: string;
  section?: string;
  description?: string;
  descriptionHeading?: string;
  room?: string;
  alternateLink?: string;
  courseState?: string;
  ownerId?: string;
  creationTime?: string;
  updateTime?: string;
  enrollmentCode?: string;
  teacherGroupEmail?: string;
  courseGroupEmail?: string;
  guardiansEnabled?: boolean;
  calendarId?: string;
}

export interface ClassroomDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface ClassroomTimeOfDay {
  hours?: number;
  minutes?: number;
  seconds?: number;
  nanos?: number;
}

export interface ClassroomCourseWork {
  courseId: string;
  id: string;
  title?: string;
  description?: string;
  materials?: unknown[];
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  dueDate?: ClassroomDate;
  dueTime?: ClassroomTimeOfDay;
  scheduledTime?: string;
  maxPoints?: number;
  workType?: string;
  topicId?: string;
  assignment?: Record<string, unknown>;
  multipleChoiceQuestion?: { choices?: string[] };
  submissionModificationMode?: string;
  assigneeMode?: string;
  individualStudentsOptions?: Record<string, unknown>;
  gradingPeriodId?: string;
}

export interface ClassroomCourseWorkMaterial {
  courseId: string;
  id: string;
  title?: string;
  description?: string;
  materials?: unknown[];
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  scheduledTime?: string;
  topicId?: string;
  assigneeMode?: string;
}

export interface ClassroomAnnouncement {
  courseId: string;
  id: string;
  text?: string;
  materials?: unknown[];
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  scheduledTime?: string;
  creatorUserId?: string;
  assigneeMode?: string;
}

export interface ClassroomTopic {
  courseId: string;
  topicId: string;
  name?: string;
  updateTime?: string;
}

export interface ClassroomSubmission {
  courseId: string;
  courseWorkId: string;
  id: string;
  userId?: string;
  associatedWithDeveloper?: boolean;
  creationTime?: string;
  updateTime?: string;
  state?: string;
  late?: boolean;
  draftGrade?: number;
  assignedGrade?: number;
  rubricId?: string;
  draftRubricGrades?: Record<string, unknown>;
  assignedRubricGrades?: Record<string, unknown>;
  submissionHistory?: unknown[];
  alternateLink?: string;
  courseWorkType?: string;
  assignmentSubmission?: { attachments?: unknown[] };
  shortAnswerSubmission?: { answer?: string };
  multipleChoiceSubmission?: { answer?: string };
}

export interface ClassroomRubric {
  courseId: string;
  courseWorkId: string;
  id: string;
  creationTime?: string;
  updateTime?: string;
  criteria?: Array<{
    id?: string;
    title?: string;
    description?: string;
    levels?: Array<{
      id?: string;
      title?: string;
      description?: string;
      points?: number;
    }>;
  }>;
}

export function dueDateIso(work: ClassroomCourseWork): string | null {
  const d = work.dueDate;
  if (!d?.year || !d.month || !d.day) return null;
  const t = work.dueTime ?? {};
  return new Date(
    Date.UTC(
      d.year,
      d.month - 1,
      d.day,
      t.hours ?? (work.dueTime ? 0 : 23),
      t.minutes ?? (work.dueTime ? 0 : 59),
      t.seconds ?? (work.dueTime ? 0 : 59),
      Math.floor((t.nanos ?? 0) / 1_000_000),
    ),
  ).toISOString();
}

export function parseRange(
  from?: string,
  to?: string,
): { fromMs: number; toMs: number } {
  const fromMs = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
  const toMs = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(fromMs)) throw new Error(`Invalid from date: ${from}`);
  if (Number.isNaN(toMs)) throw new Error(`Invalid to date: ${to}`);
  if (fromMs > toMs) throw new Error("from must be <= to");
  return { fromMs, toMs };
}

export function inRange(
  value: string | null | undefined,
  range: { fromMs: number; toMs: number },
): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && ms >= range.fromMs && ms <= range.toMs;
}

export type AssignmentStatus =
  | "upcoming"
  | "missing"
  | "turned_in"
  | "returned"
  | "reclaimed"
  | "no_due";

export function assignmentStatus(
  work: ClassroomCourseWork,
  submission: ClassroomSubmission | undefined,
  nowMs = Date.now(),
): AssignmentStatus {
  const state = submission?.state;
  if (state === "TURNED_IN") return "turned_in";
  if (state === "RETURNED") return "returned";
  if (state === "RECLAIMED_BY_STUDENT") return "reclaimed";
  const due = dueDateIso(work);
  if (!due) return "no_due";
  return Date.parse(due) < nowMs ? "missing" : "upcoming";
}

export function compactAssignment(
  work: ClassroomCourseWork,
  submission?: ClassroomSubmission,
) {
  return {
    ...work,
    courseId: work.courseId,
    id: work.id,
    title: work.title,
    description: work.description,
    workType: work.workType,
    topicId: work.topicId,
    dueAt: dueDateIso(work),
    maxPoints: work.maxPoints,
    scheduledTime: work.scheduledTime,
    submissionModificationMode: work.submissionModificationMode,
    gradingPeriodId: work.gradingPeriodId,
    multipleChoiceChoices: work.multipleChoiceQuestion?.choices ?? [],
    alternateLink: work.alternateLink,
    creationTime: work.creationTime,
    updateTime: work.updateTime,
    materials: work.materials ?? [],
    status: assignmentStatus(work, submission),
    submission: submission
      ? {
          ...submission,
          id: submission.id,
          state: submission.state,
          late: submission.late,
          draftGrade: submission.draftGrade,
          assignedGrade: submission.assignedGrade,
          rubricId: submission.rubricId,
          draftRubricGrades: submission.draftRubricGrades,
          assignedRubricGrades: submission.assignedRubricGrades,
          submissionHistory: submission.submissionHistory,
          updateTime: submission.updateTime,
          alternateLink: submission.alternateLink,
          shortAnswer: submission.shortAnswerSubmission?.answer,
          multipleChoiceAnswer: submission.multipleChoiceSubmission?.answer,
          attachments: submission.assignmentSubmission?.attachments ?? [],
        }
      : null,
  };
}
