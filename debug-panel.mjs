#!/usr/bin/env node

/**
 * DEBUG script — renders ONLY "Connections Overview" (panel 23) with extensive diagnostics.
 * Usage: node debug-panel.mjs https://USER:PASS@pmm-server --node NODENAME --service SERVICENAME
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Parse args (minimal — just URL, node, service)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const PMMSERVER = args[0]?.replace(/\/+$/, "");
const nodeIdx = args.indexOf("--node");
const serviceIdx = args.indexOf("--service");
const NODE = nodeIdx !== -1 ? args[nodeIdx + 1] : null;
const SERVICE = serviceIdx !== -1 ? args[serviceIdx + 1] : null;

if (!PMMSERVER || !NODE || !SERVICE) {
  console.error("Usage: node debug-panel.mjs https://USER:PASS@pmm-server --node NODENAME --service SERVICENAME");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers (copied from main script)
// ---------------------------------------------------------------------------
function parseCredentials(urlStr) {
  const protoMatch = urlStr.match(/^(https?:\/\/)/);
  if (!protoMatch) return null;
  const afterProto = urlStr.slice(protoMatch[1].length);
  const atIdx = afterProto.lastIndexOf("@");
  if (atIdx === -1) return null;
  const userInfo = afterProto.slice(0, atIdx);
  const hostAndPath = afterProto.slice(atIdx + 1);
  const colonIdx = userInfo.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    username: decodeURIComponent(userInfo.slice(0, colonIdx)),
    password: decodeURIComponent(userInfo.slice(colonIdx + 1)),
    cleanUrl: `${protoMatch[1]}${hostAndPath}`.replace(/\/+$/, ""),
  };
}

function getCleanUrl() {
  const creds = parseCredentials(PMMSERVER);
  return creds ? creds.cleanUrl : PMMSERVER;
}

let sessionCookie = null;

function buildHeaders() {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  } else {
    const creds = parseCredentials(PMMSERVER);
    if (creds) {
      headers["Authorization"] = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    }
  }
  return headers;
}

async function grafanaLogin() {
  const creds = parseCredentials(PMMSERVER);
  if (!creds) return;
  const url = `${getCleanUrl()}/graph/login`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: creds.username, password: creds.password }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`## LOGIN: ${response.status}`);
  const setCookies = response.headers.getSetCookie?.() || [];
  const allCookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (allCookies) {
    sessionCookie = allCookies;
    console.log(`## Cookies: ${sessionCookie}`);
  }
}

function getValidFilename(s) {
  return s.trim().replace(/\s+/g, "_").replace(/[^\w.-]/g, "");
}

// ---------------------------------------------------------------------------
// Main debug flow
// ---------------------------------------------------------------------------
async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  await grafanaLogin();

  const cleanUrl = getCleanUrl();
  const dashboardUid = "postgresql-instance-summary";
  const slug = "postgresql-instance-summary";
  const panelId = 23;
  const panelTitle = "Connections Overview";
  const outputDir = "debug_output";

  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  const now = Date.now();
  const timeFrom = now - 86400 * 1000;
  const timeTo = now;

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  });

  // Inject cookies
  if (sessionCookie) {
    const urlObj = new URL(cleanUrl);
    const cookies = sessionCookie.split("; ").map((pair) => {
      const [name, ...rest] = pair.split("=");
      return {
        name,
        value: rest.join("="),
        domain: urlObj.hostname,
        path: "/",
        secure: urlObj.protocol === "https:",
        httpOnly: true,
      };
    });
    await context.addCookies(cookies);
    console.log(`## Injected ${cookies.length} cookie(s) into browser`);
  }

  // =========================================================================
  // STEP 1: Load full dashboard (NO viewPanel) to resolve template variables
  // =========================================================================
  console.log("\n== STEP 1: Load full dashboard to resolve template variables ==");

  const initParams = new URLSearchParams({
    orgId: "1",
    refresh: "1m",
    from: String(timeFrom),
    to: String(timeTo),
    "var-service_name": SERVICE,
    "var-node_name": NODE,
    "var-interval": "5s",
    theme: "light",
    "var-database": "$__all",
  });

  const initUrl = `${cleanUrl}/pmm-ui/graph/d/${dashboardUid}/${slug}?${initParams}&kiosk`;
  console.log(`   Init URL: ${initUrl}`);

  const initPage = await context.newPage();
  const t0 = Date.now();
  await initPage.goto(initUrl, { waitUntil: "networkidle", timeout: 90_000 });
  console.log(`   networkidle took ${Date.now() - t0}ms`);

  // Wait extra for template variable queries to resolve
  await initPage.waitForTimeout(10000);
  console.log(`   Waited 10s extra for variables`);

  // Find the Grafana iframe and extract its resolved URL
  let resolvedBaseUrl = null;
  const initMainFrame = initPage.mainFrame();
  for (const frame of initPage.frames()) {
    if (frame === initMainFrame) continue;
    const frameUrl = frame.url();
    if (frameUrl.includes("/graph/d/") || frameUrl.includes("/d/")) {
      resolvedBaseUrl = frameUrl;
      break;
    }
  }

  await initPage.screenshot({ path: path.join(outputDir, "00_full_dashboard.png"), fullPage: false });
  console.log("   Saved 00_full_dashboard.png");

  if (resolvedBaseUrl) {
    console.log(`   Resolved iframe URL (${resolvedBaseUrl.length} chars):`);
    // Log the resolved variables (just the var- params)
    const resolvedUrl = new URL(resolvedBaseUrl);
    const varParams = [...resolvedUrl.searchParams.entries()].filter(([k]) => k.startsWith("var-"));
    console.log(`   ${varParams.length} template variables resolved:`);
    for (const [k, v] of varParams) {
      console.log(`     ${k} = ${v.length > 50 ? v.slice(0, 50) + "..." : v}`);
    }
    await writeFile(path.join(outputDir, "resolved_url.txt"), resolvedBaseUrl);
    console.log("   Saved resolved_url.txt");
  } else {
    console.log("   WARNING: No Grafana iframe found!");
  }

  await initPage.close();

  // =========================================================================
  // STEP 2: Load panel using resolved URL + viewPanel
  // =========================================================================
  console.log("\n== STEP 2: Load panel with resolved variables ==");

  let panelUrl;
  if (resolvedBaseUrl) {
    const resolved = new URL(resolvedBaseUrl);
    resolved.searchParams.set("viewPanel", `panel-${panelId}`);
    const pmmPath = resolved.pathname.replace(/^\/graph\//, "/pmm-ui/graph/");
    panelUrl = `${resolved.origin}${pmmPath}?${resolved.searchParams}&kiosk`;
  } else {
    // Fallback: basic URL (same as before — will likely show "No data")
    const params = new URLSearchParams({
      orgId: "1",
      refresh: "1m",
      viewPanel: `panel-${panelId}`,
      from: String(timeFrom),
      to: String(timeTo),
      "var-service_name": SERVICE,
      "var-node_name": NODE,
      "var-interval": "5s",
      theme: "light",
      "var-database": "$__all",
    });
    panelUrl = `${cleanUrl}/pmm-ui/graph/d/${dashboardUid}/${slug}?${params}&kiosk`;
  }

  console.log(`   Panel URL (${panelUrl.length} chars)`);

  const page = await context.newPage();
  const t1 = Date.now();
  await page.goto(panelUrl, { waitUntil: "networkidle", timeout: 90_000 });
  console.log(`   networkidle took ${Date.now() - t1}ms`);

  await page.screenshot({ path: path.join(outputDir, "01_after_networkidle.png"), fullPage: false });
  console.log("   Saved 01_after_networkidle.png");

  // =========================================================================
  // STEP 3: Identify frames
  // =========================================================================
  console.log("\n== STEP 3: Frames ==");
  const frames = page.frames();
  console.log(`   ${frames.length} frame(s):`);
  for (let i = 0; i < frames.length; i++) {
    console.log(`   [${i}] ${frames[i] === page.mainFrame() ? "(main)" : "(child)"} ${frames[i].url().slice(0, 120)}...`);
  }

  // Find the Grafana iframe
  let targetFrame = page;
  const mainFrame = page.mainFrame();
  for (const frame of frames) {
    if (frame === mainFrame) continue;
    const frameUrl = frame.url();
    if (frameUrl.includes("/graph/d/") || frameUrl.includes("/d-solo/") || frameUrl.includes("/d/")) {
      targetFrame = frame;
      console.log(`   => Using child iframe`);
      break;
    }
  }

  if (targetFrame === page) {
    console.log("   => WARNING: No child iframe found, using main frame");
  }

  // =========================================================================
  // STEP 4: Wait for panel element
  // =========================================================================
  console.log(`\n== STEP 4: Wait for [data-viz-panel-key="panel-${panelId}"] ==`);
  const vizSelector = `[data-viz-panel-key="panel-${panelId}"]`;

  try {
    const t2 = Date.now();
    await targetFrame.waitForSelector(vizSelector, { timeout: 30_000 });
    console.log(`   Found in ${Date.now() - t2}ms`);
  } catch {
    console.log(`   NOT FOUND after 30s`);
  }

  // =========================================================================
  // STEP 5: Wait extra 5 seconds and re-check DOM
  // =========================================================================
  console.log("\n== STEP 5: Wait 5 more seconds ==");
  await page.waitForTimeout(5000);

  await page.screenshot({ path: path.join(outputDir, "02_after_5s_extra.png"), fullPage: false });
  console.log("   Saved 02_after_5s_extra.png");

  // Re-check canvas count
  const canvasCount2 = await targetFrame.evaluate(() => document.querySelectorAll("canvas").length);
  console.log(`   Canvas count now: ${canvasCount2}`);

  // Check for "No data" text
  const noDataText = await targetFrame.evaluate(() => {
    const el = document.querySelector('[data-testid="data-testid panel content"]');
    return el?.textContent?.trim().slice(0, 100) || "(no panel content found)";
  });
  console.log(`   Panel content text: "${noDataText}"`);

  // =========================================================================
  // STEP 6: Try all screenshot selectors
  // =========================================================================
  console.log("\n== STEP 6: Screenshot attempts ==");

  const sectionSelector = `section[data-testid="data-testid Panel header ${panelTitle}"]`;
  const contentSelector = '[data-testid="data-testid panel content"]';

  const selectors = [
    { name: "section (header+content)", sel: sectionSelector },
    { name: "data-viz-panel-key", sel: vizSelector },
    { name: "panel content", sel: contentSelector },
  ];

  for (const { name, sel } of selectors) {
    const el = await targetFrame.$(sel);
    if (el) {
      const box = await el.boundingBox();
      console.log(`   [${name}] FOUND — bounding box: ${JSON.stringify(box)}`);
      await el.screenshot({ path: path.join(outputDir, `03_element_${getValidFilename(name)}.png`) });
      console.log(`   Saved 03_element_${getValidFilename(name)}.png`);
    } else {
      console.log(`   [${name}] NOT FOUND`);
    }
  }

  // Full page screenshot for comparison
  await page.screenshot({ path: path.join(outputDir, "04_fullpage.png"), fullPage: false });
  console.log("   Saved 04_fullpage.png");

  // =========================================================================
  // STEP 7: Save iframe HTML for inspection
  // =========================================================================
  console.log("\n== STEP 7: Save frame HTML ==");
  const html = await targetFrame.content();
  await writeFile(path.join(outputDir, "iframe_content.html"), html);
  console.log(`   Saved iframe_content.html (${html.length} bytes)`);

  // Cleanup
  await page.close();
  await context.close();
  await browser.close();

  console.log("\n== DEBUG COMPLETE ==");
  console.log(`Check the '${outputDir}/' folder for screenshots and HTML dump.`);
}

try {
  await main();
} catch (err) {
  console.error(`Exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
