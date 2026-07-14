/**
 * Capture connected-wallet + Your positions panel screenshots for #5243
 * (Path C2 contract). Fixed viewport only — never fullPage or element crops.
 *
 * Usage (with dev servers running — pass base URL explicitly):
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
  await readFile(new URL("./fixtures/wallet-positions-screenshot.json", import.meta.url), "utf8"),
);
const BASE_URL = process.env.UI_BASE_URL ?? "http://127.0.0.1:8085";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const WALLET_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const PAGE_PATH = process.env.SCREENSHOT_PAGE_PATH ?? "/";
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

async function installPositionsFixture(page) {
  await page.route("**/api/v1/accounts/*/wallet-positions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(POSITIONS_FIXTURE),
    });
  });
}

async function primeWallet(page) {
  await page.evaluate((addr) => {
    localStorage.setItem("mg-connected-wallet", addr);
    window.dispatchEvent(new CustomEvent("mg-wallet-change", { detail: addr }));
  }, WALLET_SS58);
}

async function openPositionsPanel(page, viewport) {
  await page.goto(`${BASE_URL}${PAGE_PATH}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });

  if (VARIANT === "after") {
    await page.getByRole("button", { name: "Connected wallet" }).waitFor({
      state: "visible",
      timeout: 30_000,
    });

    // Positions is md+ only in the header; briefly widen on mobile to click it.
    const needsWideClick = viewport.width < 768;
    if (needsWideClick) {
      await page.setViewportSize({ width: 1280, height: 800 });
    }

    const positionsBtn = page.getByRole("button", { name: "Positions" });
    await positionsBtn.waitFor({ state: "visible", timeout: 30_000 });
    await positionsBtn.click();

    if (needsWideClick) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    }

    await page.getByRole("heading", { name: "Your positions" }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByText("SN1").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(300);
    return;
  }

  // Before: no wallet UI — capture the app shell header on the registry home page.
  await page.locator("header.mg-header").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function captureViewport(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: false });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();

    if (VARIANT === "after") {
      await installPositionsFixture(page);
    }

    for (const theme of THEMES) {
      await setTheme(page, theme);
      if (VARIANT === "after") {
        await primeWallet(page);
      }
      await openPositionsPanel(page, viewport);
      const file = path.join(OUT_DIR, `5243-${viewport.name}-${theme}-${VARIANT}.png`);
      await captureViewport(page, file);
      console.log(`wrote ${file}`);
    }

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
