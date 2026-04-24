import type { Page } from 'playwright-core';

export interface BundleAnalysis {
  testIds: string[];
  apiEndpoints: string[];
  routes: string[];
  errorMessages: string[];
  featureKeys: string[];
  selectors: string[];
  totalBundleSize: number;
  bundleCount: number;
}

/**
 * Extract useful strings from the dApp's JS bundles.
 * Downloads all JS files loaded by the page and mines them for:
 * - data-testid values
 * - API endpoints
 * - Route paths
 * - Error messages
 * - CSS/DOM selectors
 *
 * Fully generic — works with any dApp's bundles regardless of framework.
 */
export async function analyzeBundles(page: Page): Promise<BundleAnalysis> {
  // Collect all JS bundle URLs loaded by the page
  const bundleUrls: string[] = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    return scripts
      .map(s => s.getAttribute('src') || '')
      .filter(src => src.endsWith('.js') || src.includes('.js?'))
      .map(src => {
        try { return new URL(src, window.location.origin).href; } catch { return ''; }
      })
      .filter(Boolean);
  });

  const testIds = new Set<string>();
  const apiEndpoints = new Set<string>();
  const routes = new Set<string>();
  const errorMessages = new Set<string>();
  const featureKeys = new Set<string>();
  const selectors = new Set<string>();
  let totalSize = 0;

  for (const url of bundleUrls) {
    try {
      const response = await page.context().request.get(url);
      const code = await response.text();
      totalSize += code.length;

      extractStrings(code, testIds, apiEndpoints, routes, errorMessages, featureKeys, selectors);
    } catch {
      // Bundle fetch failed — non-fatal
    }
  }

  // Also check inline scripts
  const inlineScripts: string[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent || '')
      .filter(t => t.length > 100 && t.length < 500000);
  });

  for (const code of inlineScripts) {
    totalSize += code.length;
    extractStrings(code, testIds, apiEndpoints, routes, errorMessages, featureKeys, selectors);
  }

  const result: BundleAnalysis = {
    testIds: [...testIds].sort(),
    apiEndpoints: [...apiEndpoints].sort(),
    routes: [...routes].sort(),
    errorMessages: [...errorMessages].sort(),
    featureKeys: [...featureKeys].sort(),
    selectors: [...selectors].sort(),
    totalBundleSize: totalSize,
    bundleCount: bundleUrls.length,
  };

  console.log(`[Bundle] Analyzed ${result.bundleCount} bundles (${(totalSize / 1024 / 1024).toFixed(1)}MB): ${result.testIds.length} testIds, ${result.apiEndpoints.length} API endpoints, ${result.routes.length} routes, ${result.errorMessages.length} error messages`);

  return result;
}

function extractStrings(
  code: string,
  testIds: Set<string>,
  apiEndpoints: Set<string>,
  routes: Set<string>,
  errorMessages: Set<string>,
  featureKeys: Set<string>,
  selectors: Set<string>,
): void {
  // data-testid values: "data-testid":"foo" or data-testid="foo" or testId:"foo"
  const testIdPatterns = [
    /data-testid[=:]["']([a-zA-Z0-9_-]+)["']/g,
    /testId[=:]\s*["']([a-zA-Z0-9_-]+)["']/g,
    /getByTestId\(["']([a-zA-Z0-9_-]+)["']\)/g,
    /\[data-testid=["']([a-zA-Z0-9_-]+)["']\]/g,
  ];
  for (const pattern of testIdPatterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1].length >= 3) testIds.add(match[1]);
    }
  }

  // API endpoints: "/api/...", "/v1/...", "/graphql"
  const apiPattern = /["'](\/(?:api|v[0-9]|graphql|rest|rpc)[a-zA-Z0-9/_-]{2,60})["']/g;
  for (const match of code.matchAll(apiPattern)) {
    apiEndpoints.add(match[1]);
  }

  // Also look for fetch/axios calls with full URLs
  const fetchPattern = /(?:fetch|axios|get|post|put)\s*\(\s*["'`](https?:\/\/[^"'`\s]{10,100})["'`]/g;
  for (const match of code.matchAll(fetchPattern)) {
    try {
      const url = new URL(match[1]);
      apiEndpoints.add(url.pathname);
    } catch {}
  }

  // Route paths: "/trade", "/portfolio", "/earn", etc.
  const routePattern = /["'](\/[a-z][a-z0-9-]{1,30}(?:\/[a-z][a-z0-9-]{1,30})*)["']/g;
  for (const match of code.matchAll(routePattern)) {
    const path = match[1];
    // Filter out common non-route paths
    if (!path.match(/^\/(api|v[0-9]|node_modules|static|assets|_next|__)/)) {
      routes.add(path);
    }
  }

  // Error messages: strings that look like user-facing errors
  const errorPatterns = [
    /["']((?:Error|Failed|Invalid|Insufficient|Unable|Cannot|Please|Wrong|Exceeded|Minimum|Maximum|Required|Rejected|Denied|Unauthorized|Forbidden|Not found|Timeout)[^"']{5,100})["']/gi,
    /["']((?:insufficient|wrong network|connect wallet|approve|rejected|slippage|gas|nonce)[^"']{3,80})["']/gi,
  ];
  for (const pattern of errorPatterns) {
    for (const match of code.matchAll(pattern)) {
      const msg = match[1].trim();
      // Skip if it looks like code rather than a message
      if (!msg.includes('(') && !msg.includes('{') && msg.length < 100) {
        errorMessages.add(msg);
      }
    }
  }

  // Feature flags / config keys
  const featurePattern = /["']((?:enable|disable|show|hide|feature|flag|toggle)[A-Z][a-zA-Z]{3,40})["']/g;
  for (const match of code.matchAll(featurePattern)) {
    featureKeys.add(match[1]);
  }

  // aria-label values (useful as selectors)
  const ariaPattern = /aria-label[=:]\s*["']([^"']{3,60})["']/g;
  for (const match of code.matchAll(ariaPattern)) {
    selectors.add(`aria:${match[1]}`);
  }
}
