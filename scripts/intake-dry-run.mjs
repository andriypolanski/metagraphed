import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadNativeSnapshot,
  loadProviders,
  normalizePublicUrl,
  repoRoot,
  slugify,
  stableStringify,
  writeJson
} from "./lib.mjs";

const args = process.argv.slice(2);
const issueJsonPath = valueAfter("--issue-json");
const outPath = valueAfter("--out");
const write = args.includes("--write");
const native = await loadNativeSnapshot();
const providers = await loadProviders();
const providerIds = new Set(providers.map((provider) => provider.id));
const importApprovalLabel = "metagraphed-import-approved";
const report = await buildReport(issueJsonPath ? JSON.parse(await fs.readFile(issueJsonPath, "utf8")) : null);

if (outPath) {
  await writeJson(path.resolve(outPath), report);
}

if (write) {
  if (!report.import_allowed) {
    console.error(`Refusing to import without schema-valid intake and ${importApprovalLabel} maintainer approval label.`);
    process.exit(1);
  }
  await writeJson(path.join(repoRoot, "registry/candidates/community", `${report.candidate.id}.json`), {
    schema_version: 1,
    generated_by: "metagraphed-intake-import",
    generated_at: report.generated_at,
    candidates: [report.candidate]
  });
}

console.log(stableStringify(report));

async function buildReport(issue) {
  const generatedAt = new Date().toISOString();
  const fields = parseIssueFields(issue?.body || "");
  const labels = issueLabels(issue);
  const importApproved = labels.includes(importApprovalLabel);
  const errors = [];

  const netuid = Number(fields.netuid);
  if (!Number.isInteger(netuid) || !native.subnets.some((subnet) => subnet.netuid === netuid)) {
    errors.push("netuid must be an active Finney netuid");
  }

  const kind = normalizeKind(fields["interface kind"] || fields.kind);
  if (!kind) {
    errors.push("interface kind is missing or unsupported");
  }

  const url = normalizePublicUrl(fields["public url"] || fields.url);
  if (!url) {
    errors.push("public URL is missing, invalid, or unsafe");
  }

  const sourceUrl = normalizePublicUrl(fields["source url"] || fields.source_url);
  if (!sourceUrl) {
    errors.push("source URL is missing, invalid, or unsafe");
  }

  const provider = slugify(fields["provider or team"] || fields.provider || "community");
  if (provider && !providerIds.has(provider)) {
    errors.push(`provider ${provider} is not registered in registry/providers`);
  }

  const authRequired = normalizeAuth(fields["does this interface require authentication?"] || fields.auth_required);
  if (authRequired === null) {
    errors.push("auth_required must be no, yes, or unknown");
  }

  const subnet = native.subnets.find((candidate) => candidate.netuid === netuid);
  const id = `community-sn-${netuid}-${kind || "surface"}-${slugify(new URL(url || "https://invalid.example").hostname)}`;
  const candidate = errors.length === 0
    ? {
        schema_version: 1,
        id,
        netuid,
        state: "schema-valid",
        name: `${subnet.name} community ${kind}`,
        kind,
        url,
        source_url: sourceUrl,
        source_urls: [sourceUrl],
        source_type: "github-issue-intake",
        source_tier: "community-docs",
        confidence: "low",
        provider,
        auth_required: authRequired,
        public_safe: true,
        rate_limit_notes: fields["rate limits or access notes"] || "",
        review_notes: `Community-submitted candidate from issue ${issue?.number || "unknown"}. Maintainer review is required before promotion.`
      }
    : null;
  const schemaValid = errors.length === 0;

  return {
    schema_version: 1,
    generated_at: generatedAt,
    issue: issue ? {
      number: issue.number || null,
      title: issue.title || null,
      author: issue.user?.login || null
    } : null,
    state: errors.length === 0 ? "schema-valid" : "schema-invalid",
    labels,
    errors,
    candidate,
    publish_allowed: false,
    import_allowed: schemaValid && importApproved,
    approval_required_label: importApprovalLabel,
    next_action: !schemaValid
      ? "resubmission-needed"
      : importApproved
        ? "open-import-pr"
        : "maintainer-review"
  };
}

function parseIssueFields(body) {
  const fields = {};
  const sections = String(body || "").split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split(/\r?\n/);
    const key = heading.trim().toLowerCase();
    const value = rest.join("\n").trim().replace(/^_No response_$/i, "");
    fields[key] = value;
  }
  return fields;
}

function normalizeKind(value) {
  const allowed = new Set([
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
  ]);
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : null;
}

function normalizeAuth(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "no") return false;
  if (normalized === "yes") return true;
  if (normalized === "unknown") return false;
  return null;
}

function issueLabels(issue) {
  return (issue?.labels || [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter(Boolean)
    .sort();
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
