#!/usr/bin/env node

import { program } from "commander";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as tar from "tar";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
program
  .name("pcs-collect-pmm-pgsql")
  .description(
    "Example: node pcs-collect-pmm-pgsql.mjs https://USER:PASS@localhost --node srq-db1 --service srq-db1-pgsql"
  )
  .version("2.0.0", "-V, --version", "Percona Consulting Scripts")
  .argument("<pmmserver>", "Base URL of PMM server (ie: https://user:pass@localhost/)")
  .option("-v, --verbose", "Increase output verbosity", false)
  .option("-d, --extra <string>", "Add additional string after hostname in collected filename")
  .option("--notar", "Do not compress the exported graphs", false)
  .option("--apikey <key>", "API Key from PMM server")
  .option("--node <name>", "Node name of audit target")
  .option("--service <name>", "Service name of audit target (ex: server1-pgsql)")
  .option("--list", "List services on PMM server", false)
  .option("--start <datetime>", "Starting date (YYYY-MM-DDTHH:MM:SS UTC). Defaults to -24h")
  .option("--end <datetime>", "Ending date (YYYY-MM-DDTHH:MM:SS UTC). Defaults to +24h from start")
  .option("--width <pixels>", "Width of image in pixels", "1280")
  .option("--height <pixels>", "Height of image in pixels", "720")
  .option("--interval <interval>", "Data point interval resolution (5s, 1h, 1d, etc)", "5s")
  .option("--database <name>", "PG database to render metrics against", "all")
  .option("--skip-pgsql", "Skip PgSQL-related graphs", false)
  .option("--skip-os", "Skip CPU/Memory/Disk-related graphs", false)
  .option("--skip-security", "Skip collection of security checks", false)
  .option("--rds", "Amazon RDS PgSQL", false)
  .option("--aurora", "Amazon RDS Aurora", false);

program.parse();
const opts = program.opts();
const PMMSERVER = program.args[0].replace(/\/+$/, "");
const APIKEY = opts.apikey ?? null;
const NODE = opts.node ?? null;
const SERVICE = opts.service ?? null;
const VERBOSE = opts.verbose;

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------
if (!opts.list && (!NODE || !SERVICE)) {
  program.error(
    "Please provide both node and service name. Use --list to view nodes and services on this PMM server."
  );
}

if (!APIKEY && !/^https?:\/\/.*:.*@/.test(PMMSERVER)) {
  program.error(`PMM URL '${PMMSERVER}' does not contain username and/or password.`);
}

if (!/^https?:\/\//.test(PMMSERVER)) {
  program.error(`PMM URL '${PMMSERVER}' does not contain protocol (http/https)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse embedded user:pass from URL.
 * Handles special characters in passwords by finding the LAST '@' before the host,
 * since passwords may contain '@'.
 */
function parseCredentials(urlStr) {
  // Match: protocol :// user : pass @ rest
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

/** Build base URL without embedded credentials (for browser navigation) */
function getCleanUrl() {
  const creds = parseCredentials(PMMSERVER);
  return creds ? creds.cleanUrl : PMMSERVER;
}

/** Build Authorization header value */
function buildAuthHeader() {
  if (APIKEY) return `Bearer ${APIKEY}`;
  const creds = parseCredentials(PMMSERVER);
  if (creds) {
    return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
  }
  return null;
}

/** Grafana session cookie, populated by grafanaLogin() */
let sessionCookie = null;

/** Build headers for API fetch calls */
function buildHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Prefer session cookie (works for all PMM endpoints), fallback to Basic/Bearer
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  } else {
    const auth = buildAuthHeader();
    if (auth) headers["Authorization"] = auth;
  }

  return headers;
}

/**
 * Authenticate via Grafana's login API and store the session cookie.
 * PMM v3 requires a Grafana session for its /v1/ API endpoints;
 * Basic auth only works on Grafana's own /graph/api/ endpoints.
 */
async function grafanaLogin() {
  const creds = parseCredentials(PMMSERVER);
  if (!creds && !APIKEY) return;

  // If using API key, just use Bearer header — no need to login
  if (APIKEY) return;

  const url = `${getCleanUrl()}/graph/login`;
  const body = JSON.stringify({ user: creds.username, password: creds.password });

  if (VERBOSE) console.log(`## LOGIN POST ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  if (VERBOSE) console.log(`## LOGIN Response: ${response.status}`);

  // Extract ALL cookies from Set-Cookie headers and send them together.
  // Grafana returns multiple cookies (grafana_session + grafana_session_expiry);
  // we need all of them, especially grafana_session (the actual auth token).
  const setCookies = response.headers.getSetCookie?.() || [];
  const allCookies = setCookies.map((c) => c.split(";")[0]).join("; ");

  if (allCookies) {
    sessionCookie = allCookies;
    if (VERBOSE) console.log(`## Session cookies acquired: ${sessionCookie}`);
  } else {
    console.log("!! Warning: Login succeeded but no session cookie received. Falling back to Basic auth.");
  }
}

/** Make a fetch call to the PMM server, bypassing TLS verification */
async function apiFetch(urlPath, fetchOpts = {}) {
  const url = `${getCleanUrl()}/${urlPath}`;
  const headers = { ...buildHeaders(), ...(fetchOpts.headers || {}) };

  if (VERBOSE) {
    const authInfo = headers["Cookie"]
      ? `Cookie: ${headers["Cookie"].slice(0, 25)}...`
      : headers["Authorization"]
        ? `Auth: ${headers["Authorization"].slice(0, 12)}...`
        : "(none)";
    console.log(`## FETCH ${fetchOpts.method || "GET"} ${url}`);
    console.log(`## ${authInfo}`);
  }

  // Use redirect: 'manual' to prevent fetch() from stripping auth on redirects
  const response = await fetch(url, {
    ...fetchOpts,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  // Handle redirects manually, re-attaching headers
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (VERBOSE) console.log(`## Redirect ${response.status} -> ${location}`);
    if (location) {
      const redirectUrl = location.startsWith("http") ? location : `${getCleanUrl()}${location}`;
      const redirectResponse = await fetch(redirectUrl, {
        ...fetchOpts,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (VERBOSE) console.log(`## Response: ${redirectResponse.status}`);
      return redirectResponse;
    }
  }

  if (VERBOSE) console.log(`## Response: ${response.status}`);
  return response;
}

/** Sanitize a string for use as a filename */
function getValidFilename(s) {
  return s
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]/g, "");
}

/** Parse the graph time window from CLI args */
function getGraphWindow(startStr, endStr) {
  let end = new Date();
  let start = new Date(end.getTime() - 86400 * 1000);

  if (startStr) {
    start = new Date(startStr + "Z");
    if (isNaN(start.getTime())) throw new Error(`Unable to parse '${startStr}' starting timestamp`);
  }

  if (endStr) {
    end = new Date(endStr + "Z");
    if (isNaN(end.getTime())) throw new Error(`Unable to parse '${endStr}' ending timestamp`);
  }

  return { timeFrom: start, timeTo: end };
}

// ---------------------------------------------------------------------------
// PMM API functions
// ---------------------------------------------------------------------------

async function getPmmVersion() {
  // Health check
  const healthResp = await apiFetch("graph/api/health");
  const health = await healthResp.json();

  if (!healthResp.ok) {
    throw new Error(`Server response: ${healthResp.status} / ${JSON.stringify(health)}`);
  }
  if (health.database !== "ok") {
    throw new Error(`Connected to PMM at '${PMMSERVER}', but PMM is not healthy.`);
  }

  // Version
  const versionResp = await apiFetch("v1/version");
  const versionData = await versionResp.json();

  if (!versionResp.ok) {
    throw new Error(`Failed to fetch PMM version: ${JSON.stringify(versionData)}`);
  }

  return versionData.version[0]; // major version number
}

/**
 * Find the UID of the Prometheus/VictoriaMetrics datasource in Grafana.
 * PMM uses this as its primary metrics datasource.
 */
async function getMetricsDatasourceUid() {
  const resp = await apiFetch("graph/api/datasources");
  if (!resp.ok) throw new Error(`Failed to fetch datasources: ${resp.status}`);
  const datasources = await resp.json();

  // Look for Prometheus or VictoriaMetrics type datasource
  const ds = datasources.find(
    (d) => d.type === "prometheus" || d.type === "victoriametrics-datasource"
  );
  if (!ds) throw new Error("No Prometheus/VictoriaMetrics datasource found in Grafana");

  if (VERBOSE) console.log(`## Datasource: ${ds.name} (uid: ${ds.uid}, type: ${ds.type})`);
  return ds.uid;
}

/**
 * Query label values from the metrics datasource via Grafana's datasource proxy.
 * This works with regular user permissions (no inventory API access needed).
 */
async function queryLabelValues(dsUid, labelName, metricMatch) {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const params = new URLSearchParams({
    "match[]": metricMatch,
    start: String(dayAgo),
    end: String(now),
  });
  const resp = await apiFetch(
    `graph/api/datasources/uid/${dsUid}/resources/api/v1/label/${labelName}/values?${params}`
  );
  if (!resp.ok) throw new Error(`Failed to query label '${labelName}': ${resp.status}`);
  const data = await resp.json();
  return data.data || [];
}

async function listServices() {
  console.log("\n-- List of Nodes and Services (from pg_up metric) --\n");

  const dsUid = await getMetricsDatasourceUid();
  const pgMatch = 'pg_up{environment=~".*", cluster=~".*"}';

  const nodeNames = await queryLabelValues(dsUid, "node_name", pgMatch);
  const serviceNames = await queryLabelValues(dsUid, "service_name", pgMatch);

  console.log("## Nodes");
  for (const name of nodeNames) {
    console.log(`-- ${name}`);
  }

  console.log("\n## Services");
  for (const name of serviceNames) {
    console.log(`-- ${name}`);
  }
}

async function getDashboard(uid) {
  const resp = await apiFetch(`graph/api/dashboards/uid/${uid}`);
  const dashboard = await resp.json();
  if (dashboard.message) throw new Error(dashboard.message);
  return dashboard;
}

async function getSecurityChecks(pathToGraphs) {
  console.log("-- Begin security check list");

  const listResp = await apiFetch("v1/management/SecurityChecks/List", { method: "POST" });
  const securityChecksList = await listResp.json();

  if (!listResp.ok || !securityChecksList.checks) {
    console.log(`!! Failed to fetch security checklist ${listResp.status} !!`);
    return;
  }

  const passingChecks = {};
  for (const check of securityChecksList.checks) {
    if (check.family === "ADVISOR_CHECK_FAMILY_MYSQL") {
      passingChecks[check.name] = {
        name: check.name,
        description: check.description,
        summary: check.summary,
        result: {},
      };
    }
  }

  const failedResp = await apiFetch("v1/management/SecurityChecks/FailedChecks", { method: "POST" });
  const failedChecks = await failedResp.json();

  if (!failedResp.ok) {
    console.log(`!! Failed to fetch failed security checks ${failedResp.status} !!`);
    return;
  }

  if (!failedChecks.results) {
    console.log("-- No failed checks found");
  } else {
    for (const fc of failedChecks.results) {
      if (fc.service_name !== SERVICE) continue;
      if (!(fc.check_name in passingChecks)) {
        console.log(`!! Failed security check ${fc.check_name} does not exist in main list !!`);
        continue;
      }
      passingChecks[fc.check_name].result = {
        summary: fc.summary,
        description: fc.description,
        severity: fc.severity,
      };
    }
  }

  await writeFile(path.join(pathToGraphs, "security_checks"), JSON.stringify(passingChecks));
  console.log("-- Finish security check list");
}

// ---------------------------------------------------------------------------
// Browser-based panel rendering
// ---------------------------------------------------------------------------

/** Collect all panels from a dashboard definition, flattening nested/collapsed rows */
function collectPanels(panels) {
  const result = [];
  for (const p of panels) {
    if (p.panels) {
      result.push(...collectPanels(p.panels));
    } else {
      result.push(p);
    }
  }
  return result;
}

async function renderDashboard(browser, dashboardUid, pathToGraphs, extraParams = {}) {
  // Sync sessionCookie from the browser context — PMM may have rotated the
  // session cookie via Set-Cookie headers during previous page loads.
  const ctxCookies = await browser.cookies();
  const pmmCookie = ctxCookies.filter((c) => c.name === "pmm_session" || c.name === "grafana_session_expiry");
  if (pmmCookie.length) {
    sessionCookie = pmmCookie.map((c) => `${c.name}=${c.value}`).join("; ");
    if (VERBOSE) console.log(`## Synced session cookie from browser context`);
  }

  const dashboard = await getDashboard(dashboardUid);
  const slug = dashboard.meta.slug;
  const allPanels = collectPanels(dashboard.dashboard.panels);

  const cleanUrl = getCleanUrl();
  const timeFromTs = extraParams.timeFrom.getTime();
  const timeToTs = extraParams.timeTo.getTime();

  // -----------------------------------------------------------------------
  // Load the full dashboard (without viewPanel) so Grafana resolves all
  // template variables (node_id, max_connections, version, etc.).
  // Many panel queries depend on these derived variables.
  // -----------------------------------------------------------------------
  const initParams = new URLSearchParams({
    orgId: "1",
    refresh: "1m",
    from: String(timeFromTs),
    to: String(timeToTs),
    "var-service_name": SERVICE,
    "var-node_name": NODE,
    "var-interval": opts.interval,
    theme: "light",
  });

  if (extraParams.cluster) initParams.set("var-cluster", extraParams.cluster);
  if (extraParams.database) {
    initParams.set("var-database", extraParams.database === "all" ? "$__all" : extraParams.database);
  }

  const initUrl = `${cleanUrl}/pmm-ui/graph/d/${dashboardUid}/${slug}?${initParams}&kiosk`;

  if (VERBOSE) console.log(`## Loading full dashboard to resolve template variables...\n## ${initUrl}`);

  const initPage = await browser.newPage();
  await initPage.goto(initUrl, { waitUntil: "networkidle", timeout: 90_000 });

  // Wait extra for template variable queries to resolve
  await initPage.waitForTimeout(10_000);

  // Find the Grafana iframe and extract its resolved URL (contains all template variables)
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

  await initPage.close();

  if (!resolvedBaseUrl) {
    console.log("!! Could not find Grafana iframe to resolve template variables, falling back to basic URL");
  } else if (VERBOSE) {
    const resolvedUrl = new URL(resolvedBaseUrl);
    const varCount = [...resolvedUrl.searchParams.keys()].filter((k) => k.startsWith("var-")).length;
    console.log(`## Resolved ${varCount} template variables from iframe URL`);
  }

  // -----------------------------------------------------------------------
  // Render each panel using the resolved URL (with all template variables)
  // -----------------------------------------------------------------------
  const titleCount = new Map();

  for (const panel of allPanels) {
    if (panel.type === "text" || panel.type === "row") continue;
    const panelTitle = panel.title.trim();
    if (!panelTitle) continue;

    const count = titleCount.get(panelTitle) || 0;
    titleCount.set(panelTitle, count + 1);

    console.log(`-- Rendering graph '${panel.title}'${count > 0 ? ` (${count})` : ""}...`);

    let url;
    if (resolvedBaseUrl) {
      // Use the resolved URL (has all template variables) and add viewPanel
      const resolved = new URL(resolvedBaseUrl);
      resolved.searchParams.set("viewPanel", `panel-${panel.id}`);
      const pmmPath = resolved.pathname.replace(/^\/graph\//, "/pmm-ui/graph/");
      url = `${resolved.origin}${pmmPath}?${resolved.searchParams}&kiosk`;
    } else {
      // Fallback: basic URL without resolved variables
      const params = new URLSearchParams({
        orgId: "1",
        refresh: "1m",
        viewPanel: `panel-${panel.id}`,
        from: String(timeFromTs),
        to: String(timeToTs),
        "var-service_name": SERVICE,
        "var-node_name": NODE,
        "var-interval": opts.interval,
        theme: "light",
      });
      if (extraParams.cluster) params.set("var-cluster", extraParams.cluster);
      if (extraParams.database) {
        params.set("var-database", extraParams.database === "all" ? "$__all" : extraParams.database);
      }
      url = `${cleanUrl}/pmm-ui/graph/d/${dashboardUid}/${slug}?${params}&kiosk`;
    }

    if (VERBOSE) console.log(`## DEBUG\n## ${url}`);

    try {
      const panelPage = await browser.newPage();
      await panelPage.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

      // PMM wraps Grafana in an iframe via /pmm-ui/. We need to find the
      // iframe containing the actual panel and work within that frame.
      let targetFrame = panelPage;

      const frames = panelPage.frames();
      if (VERBOSE) console.log(`   (${frames.length} frame(s) on page: ${frames.map((f) => f.url()).join(", ")})`);

      // Look for the Grafana iframe. PMM serves /pmm-ui/graph/d/... as the main page,
      // which embeds Grafana at /graph/d/... (without /pmm-ui/) in an iframe.
      // Skip the main frame and find the child iframe with the Grafana content.
      const mainFrame = panelPage.mainFrame();
      for (const frame of frames) {
        if (frame === mainFrame) continue; // skip the top-level page
        const frameUrl = frame.url();
        if (frameUrl.includes("/graph/d/") || frameUrl.includes("/d-solo/") || frameUrl.includes("/d/")) {
          targetFrame = frame;
          if (VERBOSE) console.log(`   (using iframe: ${frameUrl})`);
          break;
        }
      }

      // Wait for the panel to be rendered inside the target frame
      const vizSelector = `[data-viz-panel-key="panel-${panel.id}"]`;
      const contentSelector = '[data-testid="data-testid panel content"]';

      try {
        await targetFrame.waitForSelector(vizSelector, { timeout: 30_000 });
        if (VERBOSE) console.log(`   (panel element appeared)`);
      } catch {
        // Fall back: wait for any canvas in any frame
        if (VERBOSE) {
          const testIds = await targetFrame.evaluate(() =>
            [...document.querySelectorAll("[data-testid], [data-viz-panel-key]")]
              .slice(0, 20)
              .map((el) => {
                const dt = el.getAttribute("data-testid") || el.getAttribute("data-viz-panel-key");
                return `${el.tagName.toLowerCase()}[${dt}]`;
              })
          );
          console.log(`   (panel not found after 30s; elements in frame: ${JSON.stringify(testIds)})`);
          // Also log iframes and their URLs if we're still on the main page
          const iframeInfo = await panelPage.evaluate(() =>
            [...document.querySelectorAll("iframe")].map((f) => f.src || "(no src)")
          );
          if (iframeInfo.length) console.log(`   (iframes on page: ${JSON.stringify(iframeInfo)})`);
        }
      }

      // Extra delay for chart animations and final rendering
      await panelPage.waitForTimeout(2000);

      const baseFilename = getValidFilename(panelTitle);
      const suffix = count > 0 ? String(count) : "";
      const filePath = path.join(pathToGraphs, `${dashboardUid}_${baseFilename}${suffix}.png`);

      // Screenshot the section element (header + content) so the panel title is included.
      // DOM structure: div[data-viz-panel-key] > section[data-testid="Panel header ..."]
      //   section contains: header (h2 title) + div[data-testid="panel content"] (chart)
      const sectionSelector = `section[data-testid="data-testid Panel header ${panelTitle}"]`;
      let panelEl =
        (await targetFrame.$(sectionSelector)) ||
        (await targetFrame.$(vizSelector)) ||
        (await targetFrame.$(contentSelector));

      if (panelEl) {
        if (VERBOSE) console.log(`   (element screenshot)`);
        await panelEl.screenshot({ path: filePath });
      } else {
        if (VERBOSE) console.log(`   (full page fallback)`);
        await panelPage.screenshot({ path: filePath, fullPage: false });
      }

      await panelPage.close();
    } catch (err) {
      console.log(`!! Error rendering graph '${panel.title}': ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Disable TLS verification globally for Node fetch
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  // Authenticate via Grafana login to get a session cookie
  // (required for PMM v3 API endpoints like /v1/inventory/*)
  await grafanaLogin();

  const pmmVersion = await getPmmVersion();
  console.log(`- Detected PMM version: ${pmmVersion}`);

  if (opts.list) {
    await listServices();
    return;
  }

  // Derive hostname from service name
  let hostname = SERVICE;
  if (hostname.endsWith("-pgsql")) hostname = hostname.slice(0, -6);

  // Parse time window
  const { timeFrom, timeTo } = getGraphWindow(opts.start, opts.end);

  // Output directory
  const ts = timeFrom.toISOString().slice(0, 10);
  const extra = opts.extra || "";
  const pathToGraphs = `${hostname}${extra}_pmm_${ts}`;

  if (!existsSync(pathToGraphs)) {
    await mkdir(pathToGraphs, { recursive: true });
  }

  // Launch browser once, reuse for all dashboards
  const contextOpts = {
    ignoreHTTPSErrors: true,
    viewport: { width: parseInt(opts.width, 10), height: parseInt(opts.height, 10) },
  };

  if (APIKEY) {
    contextOpts.extraHTTPHeaders = { Authorization: `Bearer ${APIKEY}` };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOpts);

  // Inject the Grafana session cookie into the browser context so panel
  // pages are authenticated (httpCredentials/Basic auth won't work on PMM v3).
  if (sessionCookie) {
    const cleanUrl = getCleanUrl();
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
    if (VERBOSE) console.log(`## Injected ${cookies.length} cookie(s) into browser context`);
  }

  // Wrap rendering calls to use the shared context
  const renderWithContext = (uid, extraParams) =>
    renderDashboard(context, uid, pathToGraphs, extraParams);

  try {
    // --- PgSQL dashboards ---
    if (!opts.skipPgsql) {
      console.log("- Collecting 'PgSQL Instance Summary' graphs (all panels)");
      await renderWithContext("postgresql-instance-summary", {
        timeFrom,
        timeTo,
        database: opts.database,
      });
    }

    // --- DBaaS: skip OS graphs ---
    if (opts.rds || opts.aurora) {
      opts.skipOs = true;
      console.log("- Not collecting OS/Memory/CPU related graphs on RDS/Aurora");
    }

    // --- OS / Node dashboards ---
    if (!opts.skipOs) {
      console.log("- Collecting 'Node Summary' graphs (all panels)");
      await renderWithContext("node-instance-summary", { timeFrom, timeTo });
    }

    // --- Security checks ---
    if (!opts.skipSecurity) {
      await getSecurityChecks(pathToGraphs);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  // --- Compress ---
  if (!opts.notar) {
    console.log("- Compressing graphs into .tgz...");
    await tar.create({ gzip: true, file: `${pathToGraphs}.tgz` }, [pathToGraphs]);
  }

  console.log("== All Done! ==");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
try {
  await main();
} catch (err) {
  console.error(`Exception: ${err.message}`);
  if (VERBOSE) console.error(err.stack);
  process.exit(1);
}
