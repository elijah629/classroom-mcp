# Google Classroom MCP — Next.js Edge + Google OAuth

A remote, read-only Google Classroom MCP designed for ChatGPT/agent clients. It replaces a local stdio + `tokens.json` architecture with a stateless Next.js App Router endpoint, OAuth discovery, an interactive Google sign-in flow, high-information Classroom tools, and Drive attachment text extraction.

## What this implementation does

- Runs `/mcp` as a web-standard MCP endpoint on the Next.js Edge runtime.
- Uses the current `@modelcontextprotocol/server` v2 API instead of the v1 monolithic SDK.
- Implements OAuth Protected Resource Metadata and OAuth Authorization Server Metadata.
- Supports both OAuth Client ID Metadata Documents (CIMD) and Dynamic Client Registration (DCR) for client compatibility.
- Sends the user through Google OAuth inside the MCP connection flow. There is no local `auth` CLI command and no `tokens.json`.
- Keeps the deployment stateless: authorization state, short-lived authorization codes, MCP access tokens, and MCP refresh tokens are encrypted opaque JWE values using `AUTH_SECRET`.
- Keeps the upstream Google refresh token out of MCP access tokens. The normal MCP bearer contains only the current short-lived Google access token; the Google refresh grant is only inside the encrypted MCP refresh token handled by `/oauth/token`.
- Uses Google REST APIs through `fetch`, avoiding Node filesystem APIs and the Node-heavy `googleapis` client.
- Reads Classroom coursework, the current student's submissions, announcements, classwork materials, topics, and course metadata.
- Normalizes Classroom attachment types: Drive files, links, YouTube videos, Forms, Gemini Gems, and NotebookLM notebooks.
- Reads actual text from attached Google Docs, Sheets, Slides, PDFs, and plain-text/JSON/XML files when requested.

The implementation is deliberately read-only. Add mutation tools later and request write scopes only for those operations.

## Model-facing tools

### `classroom_overview`
Use this first for planning. It joins active courses + all published coursework + the authenticated student's submissions, and by default also folds in announcements and class materials. It supports date bounds, assignment-status filtering, selected courses, optional no-due-date work, and bounded post counts. Assignment date bounds use due dates; announcement/material bounds use post update/creation time.

Typical questions: “What is due this week?”, “What did my teachers post this week?”, “What am I missing?”, “Give me a plan for tonight.”

### `classroom_course_context`
Returns one joined course bundle: metadata, topics, assignments + submission status, classwork materials, announcements, and normalized attachments. With `attachmentMode: "text"`, it also reads a bounded number of Drive attachments so a model can directly reference a syllabus or handout.

Typical questions: “What are the grading rules in Chemistry?”, “What did my teacher post this week?”, “Use the syllabus when answering.”

### `classroom_assignment_context`
Returns a specific assignment, its rubric, the current student's submission/grade and rubric-grade state, teacher-provided attachments, and submitted attachments. It can also extract attachment text.

Typical questions: “Break down this assignment,” “What exactly do I need to submit?”, “Compare my work to the directions.”

### `classroom_search`
Searches assignment titles/descriptions, materials, announcements, teacher attachment titles/links, and the authenticated student's own submitted attachment titles across selected courses and an optional date range. `searchAttachmentContents: true` performs a bounded deep search inside Drive attachments from both teachers and the student's submissions, useful when you remember a rule from a syllabus or an old file but not its filename.

Typical questions: “Find my syllabus,” “Where did the teacher mention Cornell notes?”, “Find the handout about Chapter 4.”

### `classroom_read_attachment`
Reads one Drive file by ID. Google Docs, Sheets, Slides, text files, JSON/XML, and text-based PDFs return extracted text plus metadata. Unsupported binary types return metadata and the Drive URL rather than hallucinated content.


## OAuth flow used by an MCP client

The Google sign-in is part of the MCP connection rather than a separate setup command:

```text
MCP client
  -> /mcp (no bearer token)
  <- 401 + WWW-Authenticate + resource_metadata
  -> /.well-known/oauth-protected-resource/mcp
  -> /.well-known/oauth-authorization-server
  -> /oauth/authorize (PKCE)
  -> accounts.google.com
  -> /oauth/google/callback
  -> client redirect URI with MCP authorization code
  -> /oauth/token
  <- MCP access token + refresh token
  -> /mcp (Bearer <MCP access token>)
```

Your Google refresh token never becomes the bearer token sent to `/mcp`; it stays inside the connector's encrypted refresh grant. This is what makes the experience behave like a normal “Connect with Google” MCP instead of asking you to paste credentials into the agent.

## Google Cloud setup

1. Create/select a Google Cloud project and enable Google Classroom API, Google Drive API, Google Docs API, Google Sheets API, and Google Slides API.
2. Configure the OAuth consent screen. For a private/personal deployment, keep the allowed account constrained with `ALLOWED_GOOGLE_EMAILS` as well.
3. Create an OAuth 2.0 **Web application** client.
4. Add this exact Google redirect URI: `https://YOUR_DOMAIN/oauth/google/callback`.
5. Copy the client ID/client secret into the Vercel environment variables shown in `.env.example`.

The requested Google scopes are read-only Classroom scopes plus `drive.readonly`. `drive.readonly` is a restricted Google scope, so a public/multi-user production app may require Google verification. A Google OAuth app left in Testing can also have short-lived refresh grants; move the consent configuration to the appropriate production state when you are ready.

## Vercel deployment

Set the environment variables from `.env.example`, deploy, then use:

```text
https://YOUR_DOMAIN/mcp
```

as the remote MCP server URL in your MCP client / ChatGPT custom app. The first unauthenticated MCP request receives the OAuth challenge; the client discovers this server's OAuth metadata and opens the authorization flow. The authorization endpoint then redirects the browser to Google, and the callback returns an MCP authorization code to the client.

For ChatGPT, keep `offline_access` advertised. This implementation adds it even if a client omits it so that an MCP refresh token can be issued and the connector does not need a Google sign-in each time the short-lived access token expires.

## Edge-runtime caveat

Everything here is written for Web APIs (`fetch`, Web Crypto, `Request`, `Response`) and marks the MCP/OAuth route handlers as `runtime = "edge"`. PDF extraction is the heaviest dependency because PDF.js-like code can create a large edge bundle. `unpdf` is loaded dynamically and the extractor has byte/page/time limits, but if Vercel rejects the Edge bundle for your plan, keep `/mcp` on Edge and move only PDF text extraction to a Node route or external document service. Google Docs/Sheets/Slides extraction does not require that fallback.

## Security notes

This project is intentionally stateless. That makes Vercel deployment simple, but it means the server cannot centrally revoke one already-issued MCP refresh token or guarantee one-time authorization-code consumption without persistent storage. Google revocation or rotating `AUTH_SECRET` invalidates access globally. If you turn this from a personal connector into a multi-user service, replace the self-contained refresh-token/code storage with a database/KV-backed authorization server that supports revocation, one-time code use, token rotation/reuse detection, and account disconnects.

Set `ALLOWED_GOOGLE_EMAILS` for a personal deployment. `ALLOWED_CIMD_HOSTS` can additionally restrict OAuth client metadata fetching; that is useful as SSRF defense-in-depth on a public endpoint.

## Current API boundaries

“Full post support” here means the Classroom objects the public API exposes to a student: coursework, course-work materials, and announcements, joined into model-friendly views. Classroom does not expose every piece of the website UI as a generic post/comment feed. Third-party Classroom add-ons, scan-only PDFs, Office binaries, videos, and arbitrary linked webpages are returned as typed metadata/links unless a dedicated extractor is added.

## Local development

Copy `.env.example` to `.env.local`, set `APP_ORIGIN` to the HTTPS origin your OAuth client can reach, then:

```bash
npm install
npm run dev
```

Google OAuth normally requires a registered redirect URI, so for local interactive OAuth use an HTTPS tunnel and set `APP_ORIGIN` to that tunnel origin.
