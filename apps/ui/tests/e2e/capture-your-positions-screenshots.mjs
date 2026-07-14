/**
 * Capture connected-wallet "Your positions" panel screenshots for #5243
 * (Path C2 contract). Fixed viewport only — never fullPage or element crops.
 *
 * Usage (with dev server running — pass its base URL explicitly):
 *   UI_BASE_URL=http://127.0.0.1:8085 VARIANT=after node tests/e2e/capture-your-positions-screenshots.mjs
 *   UI_BASE_URL=http://127.0.0.1:8086 VARIANT=before node tests/e2e/capture-your-positions-screenshots.mjs
 *
 * Writes to tmp/your-positions-screenshots/5243-{viewport}-{theme}-{variant}.png
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../../../tmp/your-positions-screenshots");
const POSITIONS_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/account-positions-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const CONNECTED_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

async function setTheme(page, theme) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("mg-theme", t);
  }, theme);
}

async function installAfterFixtures(page) {
  await page.route("**/api/v1/accounts/*/positions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(POSITIONS_FIXTURE),
    });
  });
}

async function prepareConnectedWallet(page) {
  await page.evaluate((address) => {
    localStorage.setItem("mg-connected-wallet", address);
  }, CONNECTED_SS58);
}

async function openAfterScene(page) {
  await page.goto(`${BASE_URL}/subnets/1`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.getByRole("button", { name: "Positions" }).click();
  await page.getByText("Your positions").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("SN1").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function openBeforeScene(page) {
  await page.goto(`${BASE_URL}/subnets/1`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(300);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  if (VARIANT === "after") {
    await installAfterFixtures(page);
  }

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      if (VARIANT === "after") {
        await prepareConnectedWallet(page);
        await openAfterScene(page);
      } else {
        await openBeforeScene(page);
      }
      const file = path.join(OUT_DIR, `5243-${viewport.name}-${theme}-${VARIANT}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`wrote ${file}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
