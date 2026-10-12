import type { BlobResourceContents } from "@modelcontextprotocol/server";
import type { GoogleContext } from "./classroom-api";
import { config } from "./config";
import {
  assertGoogleScopes,
  describeError,
  googleFetch,
  googleJson,
} from "./google-api";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";

export type NormalizedAttachment =
  | {
      kind: "drive";
      id: string;
      title?: string;
      url?: string;
      shareMode?: string;
    }
  | { kind: "link"; url: string; title?: string; thumbnailUrl?: string }
  | {
      kind: "youtube";
      id?: string;
      title?: string;
      url?: string;
      thumbnailUrl?: string;
    }
  | {
      kind: "form";
      formUrl?: string;
      responseUrl?: string;
      title?: string;
      thumbnailUrl?: string;
    }
  | { kind: "gem"; id?: string; title?: string; url?: string }
  | { kind: "notebook"; id?: string; title?: string; url?: string }
  | { kind: "unknown"; raw: unknown };

export interface DriveFileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  size?: string;
  description?: string;
  md5Checksum?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

interface AttachmentShape {
  id?: string;
  title?: string;
  alternateLink?: string;
  shareMode?: string;
  url?: string;
  thumbnailUrl?: string;
  formUrl?: string;
  responseUrl?: string;
  driveFile?: AttachmentShape;
  youtubeVideo?: AttachmentShape;
  youTubeVideo?: AttachmentShape;
  link?: AttachmentShape;
  form?: AttachmentShape;
  gem?: AttachmentShape;
  notebook?: AttachmentShape;
}
export function normalizeAttachment(raw: unknown): NormalizedAttachment {
  if (!raw || typeof raw !== "object") return { kind: "unknown", raw };
  const value = raw as AttachmentShape;
  // Course materials wrap SharedDriveFile; student submissions contain DriveFile.
  const drive = value.driveFile?.driveFile ?? value.driveFile;
  if (drive?.id) {
    return {
      kind: "drive",
      id: drive.id,
      title: drive.title,
      url: drive.alternateLink,
      shareMode: value?.driveFile?.shareMode,
    };
  }
  const youtube = value?.youtubeVideo ?? value?.youTubeVideo;
  if (youtube) {
    return {
      kind: "youtube",
      id: youtube.id,
      title: youtube.title,
      url: youtube.alternateLink,
      thumbnailUrl: youtube.thumbnailUrl,
    };
  }
  if (value?.link?.url) {
    return {
      kind: "link",
      url: value.link.url,
      title: value.link.title,
      thumbnailUrl: value.link.thumbnailUrl,
    };
  }
  if (value?.form) {
    return {
      kind: "form",
      formUrl: value.form.formUrl,
      responseUrl: value.form.responseUrl,
      title: value.form.title,
      thumbnailUrl: value.form.thumbnailUrl,
    };
  }
  if (value?.gem) {
    return {
      kind: "gem",
      id: value.gem.id,
      title: value.gem.title,
      url: value.gem.url,
    };
  }
  if (value?.notebook) {
    return {
      kind: "notebook",
      id: value.notebook.id,
      title: value.notebook.title,
      url: value.notebook.url,
    };
  }
  return { kind: "unknown", raw };
}

export function normalizeAttachments(
  raw: unknown[] | undefined,
): NormalizedAttachment[] {
  return (raw ?? []).map(normalizeAttachment);
}

export interface AttachmentReference {
  attachment: NormalizedAttachment;
  raw: unknown;
  courseId?: string;
  courseWorkId?: string;
  itemId?: string;
  source: "teacher" | "student" | "unspecified";
  sourceType:
    | "assignment"
    | "submission"
    | "material"
    | "announcement"
    | "file";
}
export function attachmentReferences(
  raw: unknown[] | undefined,
  source: Omit<AttachmentReference, "attachment" | "raw">,
): AttachmentReference[] {
  return (raw ?? []).map((item) => ({
    ...source,
    raw: item,
    attachment: normalizeAttachment(item),
  }));
}
export function attachmentUri(fileId: string) {
  return `classroom-drive://files/${encodeURIComponent(fileId)}`;
}
export interface OriginalFileResult {
  fileId: string;
  file?: DriveFileMetadata;
  uri: string;
  url: string;
  delivery: "original" | "drive_mcp";
  reason?: string;
  error?: Record<string, unknown>;
  bytes?: number;
  resource?: BlobResourceContents;
}
export async function getDriveFileMetadata(
  accessToken: string,
  fileId: string,
): Promise<DriveFileMetadata> {
  const url = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,createdTime,webViewLink,webContentLink,size,description,md5Checksum,shortcutDetails",
  );
  url.searchParams.set("supportsAllDrives", "true");
  return googleJson<DriveFileMetadata>(accessToken, url);
}
async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new Error("Original exceeds download byte budget; use Drive MCP.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error(
          "Original exceeds download byte budget; use Drive MCP.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function readOriginalFile(
  context: GoogleContext,
  fileId: string,
  maximum = config.maxAttachmentBytes,
): Promise<OriginalFileResult> {
  const result: OriginalFileResult = {
    fileId,
    uri: attachmentUri(fileId),
    url: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
    delivery: "drive_mcp",
  };
  try {
    assertGoogleScopes(context.scopes, [
      DRIVE_READ,
      "https://www.googleapis.com/auth/drive",
    ]);
    result.file = await getDriveFileMetadata(context.accessToken, fileId);
    result.url = result.file.webViewLink ?? result.url;
    if (result.file.mimeType?.startsWith("application/vnd.google-apps."))
      return {
        ...result,
        reason:
          "Google-native document or shortcut: use Drive MCP to access the source. No implicit export or text extraction.",
      };
    if (maximum <= 0 || Number(result.file.size) > maximum)
      return {
        ...result,
        reason: "Original exceeds download byte budget; use Drive MCP.",
      };
    const url = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await googleFetch(context.accessToken, url);
    const bytes = await boundedBytes(response, maximum);
    return {
      ...result,
      delivery: "original",
      bytes: bytes.byteLength,
      resource: {
        uri: result.uri,
        mimeType:
          result.file.mimeType ??
          response.headers.get("Content-Type") ??
          "application/octet-stream",
        blob: Buffer.from(bytes).toString("base64"),
      },
    };
  } catch (error) {
    return {
      ...result,
      reason: "Original unavailable; use Drive MCP with this fileId or URL.",
      error: describeError(error),
    };
  }
}
export async function collectOriginalFiles(
  context: GoogleContext,
  references: AttachmentReference[],
  includeFiles: boolean,
  clientSupportsBinaryResources: boolean,
) {
  const groups = new Map<string, AttachmentReference[]>();
  for (const reference of references)
    if (reference.attachment.kind === "drive") {
      const key = reference.attachment.id;
      groups.set(key, [...(groups.get(key) ?? []), reference]);
    }
  const resources: BlobResourceContents[] = [];
  const files: Array<
    Omit<OriginalFileResult, "resource"> & { references: AttachmentReference[] }
  > = [];
  let attempts = 0;
  let totalBytes = 0;
  for (const [fileId, refs] of groups) {
    let result: OriginalFileResult;
    if (
      !includeFiles ||
      !clientSupportsBinaryResources ||
      attempts >= config.maxAttachmentFiles
    ) {
      result = {
        fileId,
        uri: attachmentUri(fileId),
        url:
          refs[0]?.attachment.kind === "drive"
            ? (refs[0].attachment.url ??
              `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`)
            : "",
        delivery: "drive_mcp",
        reason: !includeFiles
          ? "Original download not requested; use Drive MCP or classroom_read_attachment."
          : !clientSupportsBinaryResources
            ? "Client cannot use binary resources; use Drive MCP."
            : "Per-request file budget reached; use Drive MCP or classroom_read_attachment.",
      };
    } else {
      attempts++;
      result = await readOriginalFile(
        context,
        fileId,
        Math.min(
          config.maxAttachmentBytes,
          config.maxAttachmentTotalBytes - totalBytes,
        ),
      );
    }
    const { resource, ...metadata } = result;
    if (resource) {
      resources.push(resource);
      totalBytes += result.bytes ?? 0;
    }
    files.push({ ...metadata, references: refs });
  }
  return {
    files,
    resources,
    references,
    totalBytes,
    note: "Original bytes only. Embedded binary resource support depends on the MCP client. If unavailable, use Drive MCP with fileId/URL. No extracted document text is supplied.",
  };
}
