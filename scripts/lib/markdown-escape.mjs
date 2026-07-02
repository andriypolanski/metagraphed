import { formatLlmMarkdownText } from "./formatting.mjs";

export function escapeMarkdownLinkText(value, { maxLength = 240 } = {}) {
  return formatLlmMarkdownText(String(value ?? ""), { maxLength });
}

export function escapeMarkdownCodeSpan(value, { maxLength = 120 } = {}) {
  return formatLlmMarkdownText(String(value ?? ""), { maxLength }).replace(
    /`/g,
    "\\`",
  );
}

export function escapeMarkdownHref(value) {
  return encodeURI(String(value ?? "")).replace(/\)/g, "%29");
}

export function markdownLink(label, href) {
  return `[${escapeMarkdownLinkText(label)}](${escapeMarkdownHref(href)})`;
}
