// End-to-end browser flow with Playwright: sign in, open a module, start a real run, watch it
// progress, inspect evidence and verdict, download the bundle, check a 390px mobile layout.
// Writes docs/evidence/browser-check.json and screenshots.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.SW_WEB ?? "http://127.0.0.1:4400";
const creds = JSON.parse(readFileSync(".local/demo-users.json", "utf8"));
const results: Record<string, unknown> = { base: BASE, started_at: new Date().toISOString() };
// Uses an already-installed Playwright Chromium if the pinned revision isn't downloaded.
const browser = await chromium.launch(process.env.SW_CHROMIUM ? { executablePath: process.env.SW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// The app probes /api/me before sign-in; that expected 401 is the only error not counted.
page.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && errors.push(m.text()));

await page.goto(BASE);
await page.getByLabel("Password").fill(creds["maya@signalworks.local"]);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("heading", { name: "Does your monitoring still tell the truth?" }).waitFor();
results.signed_in = true;

await page.getByRole("button", { name: "MetricContract" }).first().click();
await page.getByRole("heading", { name: "MetricContract", exact: true }).waitFor();
await page.getByLabel("Candidate").selectOption("v5");
await page.getByLabel("Planner").selectOption("baseline");
await page.getByRole("button", { name: "Start run" }).click();
await page.waitForURL(/#\/run\//);
results.run_url = page.url();
await page.getByRole("heading", { name: /Verdict: (fail|pass|inconclusive)/ }).waitFor({ timeout: 240_000 });
const verdict = await page.locator(".verdict h3").innerText();
results.verdict_text = verdict;
results.finding_visible = await page.getByText("unit_witnessed").first().isVisible();
results.evidence_panels = await page.locator(".panel strong").count();
await page.screenshot({ path: "docs/evidence/browser-run-desktop.png", fullPage: false });

const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download evidence bundle" }).click()]);
const path = await download.path();
const bundle = JSON.parse(readFileSync(path!, "utf8"));
results.bundle = { provenance: bundle.provenance, has_sha256: typeof bundle.sha256 === "string", tool_calls: bundle.tool_calls.length, findings: bundle.findings.length, artifacts: bundle.artifacts.length };

// Evidence drawer opens from the tool-call table with the keyboard.
await page.locator("tr.clickable").first().focus();
await page.keyboard.press("Enter");
results.drawer_opened = await page.getByRole("dialog", { name: "Tool call evidence" }).isVisible();
await page.getByRole("button", { name: "Close" }).click();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.context().addCookies(await page.context().cookies());
await mobile.goto(`${BASE}/#/module/alertscenario`);
await mobile.getByRole("heading", { name: "AlertScenario", exact: true }).waitFor();
results.mobile_no_horizontal_scroll = await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
await mobile.screenshot({ path: "docs/evidence/browser-module-mobile.png", fullPage: false });

results.page_errors = errors;
results.finished_at = new Date().toISOString();
writeFileSync("docs/evidence/browser-check.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
await browser.close();
const ok = results.signed_in && results.finding_visible && results.drawer_opened && results.mobile_no_horizontal_scroll && (results.bundle as any).has_sha256 && errors.length === 0;
process.exit(ok ? 0 : 1);
