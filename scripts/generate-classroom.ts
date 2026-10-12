import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const directory = new URL("../src/lib/discovery/", import.meta.url);
if (process.argv.includes("--refresh")) {
  const response = await fetch(
    "https://classroom.googleapis.com/$discovery/rest?version=v1",
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok)
    throw new Error(
      `Stable Discovery fetch failed (${response.status}); existing snapshot preserved`,
    );
  const document = await response.json();
  if (!document.resources || !document.schemas)
    throw new Error("Invalid Discovery document");
  await writeFile(
    new URL("stable.json", directory),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}
// Load after refresh, avoiding cached imports of the previous snapshot.
const { methodInputSchema, stableDiscovery, stableMethods } = await import(
  "../src/lib/discovery"
);
const tools = stableMethods.map((method) => {
  let name = method.id.replaceAll(".", "_");
  if (name.length > 64)
    name = `${name.slice(0, 55)}_${createHash("sha256").update(method.id).digest("hex").slice(0, 8)}`;
  methodInputSchema(method); // Fail generation on unresolved references.
  return { name, methodId: method.id };
});
if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
  throw new Error("Tool name collision");
const catalog = { stableRevision: stableDiscovery.revision, tools };
const generated = `${JSON.stringify(catalog, null, 2)}\n`;
const file = new URL("catalog.json", directory);
const rows = tools.map((tool) => `| \`${tool.name}\` | \`${tool.methodId}\` |`);
const coverage = `# Classroom API coverage\n\nGenerated from the official stable v1 Discovery snapshot, revision ${catalog.stableRevision}. ${tools.length} stable methods, each with an independent tool.\n\n| Tool | Google method |\n| --- | --- |\n${rows.join("\n")}\n`;
const coverageFile = new URL("../../../API_COVERAGE.md", directory);
if (process.argv.includes("--check")) {
  if (
    (await readFile(file, "utf8")) !== generated ||
    (await readFile(coverageFile, "utf8")) !== coverage
  )
    throw new Error(
      "Discovery catalog or coverage stale; run bun run generate:classroom",
    );
} else {
  await writeFile(file, generated);
  await writeFile(coverageFile, coverage);
}
console.log(
  `${tools.length} independent stable Classroom tools; schema references resolved.`,
);
