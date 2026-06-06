import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const templateRoot = path.join(repoRoot, ".github/ISSUE_TEMPLATE");
const interfaceTemplate = await fs.readFile(path.join(templateRoot, "add-update-subnet-interface.yml"), "utf8");
const statusTemplate = await fs.readFile(path.join(templateRoot, "report-endpoint-status-issue.yml"), "utf8");
const errors = [];

checkIncludes(interfaceTemplate.toLowerCase(), "interface template", [
  "interface-submission",
  "maintainer-review",
  "id: netuid",
  "id: kind",
  "id: url",
  "id: source_url",
  "id: auth_required",
  "schema-valid submissions are not auto-published",
  "metagraphed-import-approved",
  "read-only probes"
]);

for (const kind of [
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
  "subtensor-rpc",
  "subtensor-wss"
]) {
  checkIncludes(interfaceTemplate, "interface template", [`- ${kind}`]);
}

checkIncludes(statusTemplate, "status template", [
  "status-report",
  "maintainer-review",
  "id: netuid",
  "id: surface_id",
  "id: issue_type",
  "unsafe-or-private",
  "This report does not include secrets"
]);

if (errors.length > 0) {
  console.error(`Intake validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Issue intake templates passed validation.");

function checkIncludes(content, label, needles) {
  for (const needle of needles) {
    if (!content.includes(needle)) {
      errors.push(`${label}: missing ${needle}`);
    }
  }
}
