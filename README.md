# Google Classroom MCP

Remote Google Classroom MCP using Next.js Route Handlers, Google OAuth and the MCP server SDK. Student workflows are the entry point; **every method in the checked-in stable Discovery specification has its own tool**, including teacher/admin methods. Google still enforces roles, scopes, domain policies, licenses, add-on ownership and project association.

Current snapshot: Google revision `20261006`, **104 independent API tools + 8 workflow/attachment tools**. Exact method-to-tool names: [API_COVERAGE.md](API_COVERAGE.md). Long names receive a deterministic hash suffix to stay within 64 characters.

## Agent workflow tools

| Tool | Use |
| --- | --- |
| `classroom_get_pending_assignments` | Upcoming/overdue pending work across active courses, compact joins, local deadlines and explicit coverage. Start here for homework/deadline questions. |
| `classroom_overview` | Bounded context: active classes, assignments, own submission status and recent posts. Empty assignments do not establish no homework when coverage is incomplete. |
| `classroom_course_context` | One course, topics, assignments, own submissions, materials, announcements; optional original-file bundle. |
| `classroom_assignment_context` | Assignment, course, rubrics, own submission and original attachments in one call; downloads enabled by default. |
| `classroom_search` | Search titles, descriptions, announcements and teacher/student attachment **metadata** across courses. |
| `classroom_attachment_bundle` | Collect assignment or class attachments; deduplicate file downloads while preserving all source references. |
| `classroom_read_attachment` | Original stored Drive file as binary resource, or explicit Drive MCP handoff. |
| `classroom_submit_assignment` | Find own submission, add specified existing files/links/videos, optionally turn in, then re-read state. |

Tools preserve original Google records in `sources`; joined views contain IDs and status for navigation. `from`/`to` apply to assignment due dates and post update/creation timestamps. `includeNoDue` defaults true. Source records describe the bounded fetched set; joined views and course attachment bundles respect filters. Overview lists student enrollment; independent tools also support teacher/admin queries.

Combined reads expose per-source errors, `partial`, `truncated`, and continuation instructions. List sources fetch at most three pages and `maxItemsPerSource` records (default 50, maximum 100). Overview defaults to at most ten courses, configurable to thirty. `continuation.arguments` can be passed to the named independent method; `offset` means skip that many records in the returned page. A failed course/source does not discard successful sources. An unavailable or incomplete submissions source cannot establish that an assignment is missing; such assignments use `unknown` status. Search is bounded; absence of a match does not establish absence from unfetched records.

### Completeness and pending work

`hadErrors` reports upstream failures. `coverageComplete` means all requested courses/sources were scanned without errors or truncation. `unknownItemsPossible` is its inverse. Legacy `partial` still means source errors only, so `partial:false` can accompany `coverageComplete:false`. `resultLimitReached` reports an output-match limit, independently of source coverage. Overview includes `coverageByCourse`, fetched counts, source continuations and applied filters. Search additionally returns `corpusComplete`, `resultsComplete`, and `negativeResult:"notFoundInScannedItems"` for zero matches with incomplete coverage. Search `matchesTruncated:false` describes only the match limit; it never guarantees corpus coverage. Response-budget fallbacks also explicitly set coverage incomplete.

For pending work:

```json
{"timeZone":"America/Los_Angeles","start":"2026-10-12T00:00:00-07:00","end":"2026-10-12T23:59:59-07:00","includeOverdue":false}
```

`timeZone` is required and validated; date bounds accept ISO timestamps with UTC or explicit offsets. Without `start`, the lower bound is the response's `asOf`. `includeOverdue` defaults true and adds deadlines before `asOf`, even before `start`; set false for a strictly upcoming date window. `end` always applies. Submitted work is excluded. Returned work is excluded unless `includeReturned:true`; returned does not imply revision needed. Undated work defaults off; opt in with `includeUndated:true` and optionally `undatedSince` to filter update/creation timestamps. Recency and topic IDs provide context, not proof of current relevance.

The pending tool fetches coursework and own submissions across pages independently of the overview's shared raw-record budget, joining by course/work ID and deduplicating repeated work IDs. It requests only summary fields from Google and never downloads attachments. Scan limits: 100 active courses, 100 pages and 10,000 records per source, plus `MAX_WORKFLOW_CHARS` per projected source. Limits/errors always set `coverageComplete:false`, with actionable independent-source continuations. Narrow `courseIds` or follow those continuations to finish an incomplete scan. `continuation.methodId` is an official Discovery method ID, mapped to the independent tool in `API_COVERAGE.md`; `arguments` are its parameters and `offset` skips items within that page.

`maxResults` defaults 50 (maximum 100). `nextCursor` pages **scanned matches**, not unscanned sources; keep filters unchanged when passing it back. Each page re-scans live Google data with a fixed `asOf`, so concurrent edits may shift result pages. `scannedMatchCount` is not an authoritative total when coverage is incomplete. `resultsComplete` requires complete coverage and no remaining match pages. Inspect coverage even when `nextCursor` is null.

Assignments retain raw `dueDate`/`dueTime`, `dueAtUtc`, `dueAtLocal` (with numeric UTC offset), `localDueDate`, and `dueTimeSpecified`. UTC time fields omitted within an existing `dueTime` mean zero; DST conversion follows the selected IANA zone. A date with no `dueTime` retains the legacy 23:59:59 UTC filter/sort convention, explicitly marked `dueTimeSpecified:false`; this is not a teacher-specified due time. `rawSubmissionState` and `studentStatus` distinguish `NEW`/`not_started`, `CREATED`/`in_progress_not_submitted`, `TURNED_IN`/`submitted`, `RETURNED`/`returned`, and `RECLAIMED_BY_STUDENT`/`reclaimed`. An absent submission remains `unknown`.

## Independent API tools

Tools map to official methods such as `classroom_courses_list`, `classroom_courses_courseWork_create`, and `classroom_courses_delete`. Each advertises parameter and request-body schemas, Google's method description, accepted OAuth scopes and mutation annotations. Parameters retain official names; request JSON is under `body`.

```json
{"courseId":"123","id":"456"}
```

Example `classroom_courses_courseWork_get` arguments. List tools return **one original Google page**, including `nextPageToken`; pass it back as `pageToken`. Repeated query parameters accept arrays. Patch/update methods retain `updateMask` and original body fields. Empty successful Google responses return `{}`. No writes are automatically retried. OAuth credentials are server-owned; transport controls such as API keys, JSONP, upload protocols and alternate non-JSON encodings are not model arguments.

### Reproducible stable API coverage

The MCP uses only the official stable v1 Discovery document.

```sh
bun run generate:classroom             # regenerate catalog and coverage offline
bun run generate:classroom --refresh   # download the official stable specification
bun run check:classroom                # verify generated catalog
```

The snapshot lives in `src/lib/discovery/stable.json`. No network discovery runs during tool calls. Review and commit the refreshed snapshot, catalog and coverage together.

## Submission workflow and limits

`classroom_submit_assignment` finds the signed-in student's submission, adds only the specified new attachments, optionally calls `turnIn`, and re-reads the result. `turnIn` defaults to `false`. Each step reports its outcome, including partial completion when attachment changes succeed but turn-in fails. The workflow never automatically reclaims a submission, removes existing attachments, or retries writes.

Google requires `modifyAttachments` and `turnIn` calls to originate from the OAuth project that created the coursework or an add-on attachment on it. Many ordinary teacher-created assignments therefore cannot be submitted through an unrelated connector. The tools retain Google's error status, reasons and details. See [turnIn](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork.studentSubmissions/turnIn) and [modifyAttachments](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork.studentSubmissions/modifyAttachments).

## Original attachments

**No document/PDF text extraction, summaries, OCR, content search or implicit conversion.** Classroom's own assignment descriptions and announcement text remain available verbatim.

Stored PDF and other downloadable Drive files return original bytes as MCP embedded binary resources (`blob`, Base64 transport encoding, original MIME type). File names, IDs, URLs and source references accompany them. Authenticated `resources/read` also supports `classroom-drive://files/{fileId}` using the same MCP bearer authorization and Google grant. Downloads are bounded while streaming; an oversized file is handed off whole, never returned partially.

Defaults: five unique download attempts, 5 MiB per file, 10 MiB total raw bytes per call. All configurable. Assignment context, attachment bundle and read-attachment download by default; course context requires `includeFiles: true`; overview/search never download. Google-native Docs/Sheets/Slides, shortcuts, oversized files and denied downloads return Drive MCP handoffs with IDs/URLs and reasons. No automatic export to PDF occurs.

MCP clients differ in support for presenting binary resources to agents. Set `clientSupportsBinaryResources: false` for an incompatible client; the connector returns Drive handoffs without downloading. Every original-file result retains IDs/URLs so the agent can use Drive MCP even if its client fails to expose the binary. Host HTTP response limits also apply; reduce raw-byte limits to allow for Base64 overhead (roughly 4/3) plus metadata. For a host with a 4.5 MiB response cap, set the total raw-byte budget to 3 MiB or lower.

The MCP endpoint automatically applies lossless HTTP gzip to successful JSON and SSE responses when the client's `Accept-Encoding` accepts gzip. Clients without gzip support receive the original encoding; already encoded responses are preserved. Streaming gzip flushes each SSE chunk without waiting for the response to finish. Clients decode HTTP gzip before reading MCP messages, so embedded PDF/file bytes, names and MIME types remain unchanged. No new environment variables are required; redeploy to activate this change.

Compression reduces transfer bytes, not the agent's decoded context size. It does not guarantee avoiding Vercel response limits, and PDFs may compress little. Keep attachment budgets and Drive handoffs enabled. For a conservative Vercel deployment, use `MAX_ATTACHMENT_BYTES=2097152` and `MAX_ATTACHMENT_TOTAL_BYTES=2097152`. Live Vercel proxy and target-client gzip behavior still require deployment testing.

## Google Cloud and OAuth

1. Enable **Google Classroom API** and **Google Drive API** in the OAuth project; Docs, Sheets and Slides APIs are no longer needed by this MCP.
2. Configure Google consent and a Web application OAuth client. Add `https://YOUR_DOMAIN/oauth/google/callback` as redirect URI.
3. Configure the Classroom scopes from both snapshots plus `drive.readonly` and OpenID identity scopes. Full Classroom scope coverage includes teacher/admin scopes; requesting them does not grant those roles. Google may require verification for public distribution and restricted Drive scopes.
4. Set `.env.example` values. Use `ALLOWED_GOOGLE_EMAILS` to constrain a personal deployment and `ALLOWED_CIMD_HOSTS=chatgpt.com` for ChatGPT CIMD.

Connect your MCP client to `https://YOUR_DOMAIN/mcp`. OAuth discovery, PKCE, CIMD/DCR and the existing sign-in/refresh architecture remain. Actual granted Google scopes are preserved through callback, encrypted authorization code, access/refresh grants and upstream refresh. Missing grants return an actionable reconnect error; existing pre-upgrade connections need reconnecting to obtain the expanded scopes. Google refresh tokens stay out of MCP access tokens. Google error details remain authoritative where permissions cannot be distinguished further.

The authorization server remains stateless. Individual issued grants cannot be centrally revoked, authorization codes are not centrally consumed once, and refresh replay detection needs durable storage. Retain a personal deployment or add persistent grant storage before requiring those capabilities. This update does not add a database, deploy anything, or mutate real classes/submissions during tests.

## Development and verification

Use **Bun 1.4.3**, as declared in `packageManager`:

```bash
bun install --frozen-lockfile
bun run check:classroom
bun test
bun run lint
bun run typecheck
bun run build
bun run dev
```

Provide configured environment variables before building/running because OAuth metadata needs `APP_ORIGIN`. Read the installed Next.js guides under `node_modules/next/dist/docs/` before framework edits, per `AGENTS.md`.

Tests compare Discovery coverage and schemas with protocol `tools/list`, exercise independent student/teacher/admin calls, request encoding, empty responses, pagination/continuations, scope preservation and refresh, Google errors, partial workflows, submission sequencing, byte-exact PDF resources, download deduplication/limits, Drive handoffs and protocol resource reads. Google HTTP is mocked. A real Google account and target client are still required to verify consent, actual turn-in eligibility and client-side PDF usability.

### Breaking changes from 0.1

- Read-only connector becomes a full Classroom API connector; reconnect for broader scopes.
- `attachmentMode: "text"`, `maxChars`, `maxTextAttachments`, `maxCharsPerAttachment` and `searchAttachmentContents` are removed and rejected. `classroom_read_attachment` returns originals/handoffs instead of extracted text.
- Workflow schemas use `maxItemsPerSource` and `maxCourses`; old `maxAssignmentsPerCourse`/`maxPostsPerCourse` are replaced. Raw records move into `sources`; inspect source errors and continuation metadata.
- `MAX_ATTACHMENT_TEXT_CHARS`, `MAX_PDF_BYTES`, `MAX_PDF_PAGES` are replaced with raw-file budgets below.

Developer Preview support has been removed. Delete `GOOGLE_API_KEY` and `GOOGLE_CLASSROOM_PREVIEW_VERSION` from Vercel environment settings; neither is read. Tools no longer accept `previewVersion` or send preview visibility headers. Stable rubric, grading-period and student-group methods remain available.
