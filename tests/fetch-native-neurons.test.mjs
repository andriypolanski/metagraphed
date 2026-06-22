import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.platform === "win32" ? "python" : "python3";

test("fetch-native-subnets --self-test normalizes SDK neuron rows (#1348)", () => {
  const result = spawnSync(
    python,
    ["scripts/fetch-native-subnets.py", "--self-test"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    [result.stderr, result.stdout].filter(Boolean).join("\n"),
  );
});
