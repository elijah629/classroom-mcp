import { config } from "./config";
import { googleFetch, googleJson, limitText } from "./google-api";

const DRIVE = "https://www.googleapis.com/drive/v3";

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

export interface AttachmentTextResult {
  file: DriveFileMetadata;
  text?: string;
  truncated?: boolean;
  extraction:
    | "google-doc"
    | "google-sheet"
    | "google-slides"
    | "pdf"
    | "text"
    | "metadata-only";
  note?: string;
}

function driveShape(raw: any): any {
  // Course materials wrap DriveFile in SharedDriveFile.driveFile; student submissions do not.
  return raw?.driveFile?.driveFile ?? raw?.driveFile;
}

export function normalizeAttachment(raw: unknown): NormalizedAttachment {
  const value = raw as any;
  const drive = driveShape(value);
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

function collectDocStructural(elements: any[] | undefined, out: string[]) {
  for (const element of elements ?? []) {
    if (element.paragraph?.elements) {
      for (const pe of element.paragraph.elements) {
        if (typeof pe.textRun?.content === "string")
          out.push(pe.textRun.content);
      }
    }
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells ?? [])
          collectDocStructural(cell.content, out);
        out.push("\n");
      }
    }
    if (element.tableOfContents?.content)
      collectDocStructural(element.tableOfContents.content, out);
  }
}

function collectDocTabs(tabs: any[] | undefined, out: string[]) {
  for (const tab of tabs ?? []) {
    const title = tab.tabProperties?.title;
    if (title) out.push(`\n# ${title}\n`);
    collectDocStructural(tab.documentTab?.body?.content, out);
    collectDocTabs(tab.childTabs, out);
  }
}

async function readGoogleDoc(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const url = new URL(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`,
  );
  url.searchParams.set("includeTabsContent", "true");
  const doc = await googleJson<any>(accessToken, url);
  const out: string[] = [];
  if (Array.isArray(doc.tabs) && doc.tabs.length) collectDocTabs(doc.tabs, out);
  else collectDocStructural(doc.body?.content, out);
  return out
    .join("")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function collectTextRuns(value: any, out: string[]) {
  if (!value || typeof value !== "object") return;
  if (typeof value.textRun?.content === "string")
    out.push(value.textRun.content);
  if (Array.isArray(value)) {
    for (const item of value) collectTextRuns(item, out);
    return;
  }
  for (const child of Object.values(value)) collectTextRuns(child, out);
}

async function readGoogleSlides(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const presentation = await googleJson<any>(
    accessToken,
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fileId)}`,
  );
  const out: string[] = [];
  const slides = presentation.slides ?? [];
  slides.forEach((slide: any, index: number) => {
    out.push(`\n# Slide ${index + 1}\n`);
    const slideText: string[] = [];
    collectTextRuns(slide, slideText);
    out.push(slideText.join(""));
  });
  return out.join("\n").trim();
}

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'!A1:Z1000`;
}

async function readGoogleSheet(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const metaUrl = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}`,
  );
  metaUrl.searchParams.set(
    "fields",
    "properties(title),sheets(properties(title,index))",
  );
  const spreadsheet = await googleJson<any>(accessToken, metaUrl);
  const sheets = (spreadsheet.sheets ?? []).slice(0, 30);
  const parts: string[] = [];
  for (const sheet of sheets) {
    const title = sheet.properties?.title;
    if (!title) continue;
    const range = quoteSheetTitle(title);
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
    );
    url.searchParams.set("majorDimension", "ROWS");
    url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
    const values = await googleJson<{ values?: unknown[][] }>(accessToken, url);
    parts.push(`\n# Sheet: ${title}\n`);
    for (const row of values.values ?? []) {
      parts.push(
        row.map((cell) => String(cell ?? "").replace(/\t/g, " ")).join("\t"),
      );
    }
  }
  return parts.join("\n").trim();
}

async function readPdf(
  accessToken: string,
  fileId: string,
  metadata: DriveFileMetadata,
): Promise<string> {
  const size = Number(metadata.size ?? "0");
  if (size && size > config.maxPdfBytes) {
    throw new Error(`pdf_too_large:${size}>${config.maxPdfBytes}`);
  }
  const url = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleFetch(accessToken, url, {
    headers: { Accept: "application/pdf" },
  });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > config.maxPdfBytes) {
    throw new Error(`pdf_too_large:${buffer.byteLength}>${config.maxPdfBytes}`);
  }

  // unpdf ships a serverless PDF.js build. Keep limits strict because PDFs are untrusted input.
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    maxImageSize: 16_777_216,
  });
  try {
    if (pdf.numPages > config.maxPdfPages) {
      throw new Error(
        `pdf_too_many_pages:${pdf.numPages}>${config.maxPdfPages}`,
      );
    }
    const extraction = extractText(pdf, { mergePages: true }).then((r) =>
      String(r.text),
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pdf_extraction_timeout")), 15_000),
    );
    return await Promise.race([extraction, timeout]);
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

async function readPlainText(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const url = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleFetch(accessToken, url, {
    headers: { Accept: "text/plain,*/*" },
  });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > config.maxPdfBytes)
    throw new Error("text_file_too_large");
  return new TextDecoder().decode(buffer);
}

export async function readDriveAttachment(
  accessToken: string,
  fileId: string,
  maxChars = config.maxAttachmentTextChars,
): Promise<AttachmentTextResult> {
  const file = await getDriveFileMetadata(accessToken, fileId);
  const mime = file.mimeType ?? "";
  let text: string | undefined;
  let extraction: AttachmentTextResult["extraction"] = "metadata-only";
  let note: string | undefined;

  if (mime === "application/vnd.google-apps.document") {
    text = await readGoogleDoc(accessToken, fileId);
    extraction = "google-doc";
  } else if (mime === "application/vnd.google-apps.spreadsheet") {
    text = await readGoogleSheet(accessToken, fileId);
    extraction = "google-sheet";
  } else if (mime === "application/vnd.google-apps.presentation") {
    text = await readGoogleSlides(accessToken, fileId);
    extraction = "google-slides";
  } else if (mime === "application/pdf") {
    text = await readPdf(accessToken, fileId, file);
    extraction = "pdf";
  } else if (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(
      mime,
    )
  ) {
    text = await readPlainText(accessToken, fileId);
    extraction = "text";
  } else {
    note = `No text extractor is configured for MIME type ${mime || "unknown"}. Metadata and webViewLink are still returned.`;
  }

  if (text === undefined) return { file, extraction, note };
  const limited = limitText(
    text,
    Math.max(1_000, Math.min(maxChars, config.maxAttachmentTextChars)),
  );
  return {
    file,
    extraction,
    text: limited.text,
    truncated: limited.truncated,
    note,
  };
}
