import type { Page } from 'playwright-core';

export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: any;
  timestamp: number;
}

export interface NetworkCapture {
  responses: CapturedResponse[];
  assets: string[];
  markets: any[];
  configs: any[];
  rawApiData: Record<string, any>;
}

/**
 * Start intercepting network responses on a page.
 * Returns a handle to stop capturing and retrieve results.
 * Fully generic — captures all JSON API responses and extracts structured data.
 */
export function startNetworkCapture(page: Page): {
  stop: () => NetworkCapture;
} {
  const responses: CapturedResponse[] = [];

  const handler = async (response: any) => {
    try {
      const url = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';

      // Skip non-JSON, non-200, and static assets
      if (status < 200 || status >= 300) return;
      if (!contentType.includes('json') && !contentType.includes('javascript')) return;
      if (url.match(/\.(js|css|png|jpg|svg|woff|ico|map)(\?|$)/)) return;
      // Skip common non-API domains
      if (url.match(/(googleapis|google-analytics|sentry|datadog|segment|hotjar|intercom|mixpanel|amplitude)\./)) return;

      const body = await response.json().catch(() => null);
      if (!body) return;

      responses.push({
        url,
        method: response.request().method(),
        status,
        contentType,
        body,
        timestamp: Date.now(),
      });
    } catch {
      // Non-fatal — skip this response
    }
  };

  page.on('response', handler);

  return {
    stop: () => {
      page.removeListener('response', handler);
      return analyzeCaptures(responses);
    },
  };
}

/**
 * Analyze captured responses to extract assets, markets, and configs.
 * Uses heuristics to identify common dApp data patterns.
 */
function analyzeCaptures(responses: CapturedResponse[]): NetworkCapture {
  const assets = new Set<string>();
  const markets: any[] = [];
  const configs: any[] = [];
  const rawApiData: Record<string, any> = {};

  for (const resp of responses) {
    const { url, body } = resp;

    // Store raw API data keyed by URL path
    try {
      const path = new URL(url).pathname;
      rawApiData[path] = body;
    } catch {}

    // Recursively search for asset/market data in the response
    findAssets(body, assets, markets, configs);
  }

  return {
    responses,
    assets: [...assets].sort(),
    markets,
    configs,
    rawApiData,
  };
}

/**
 * Recursively search a JSON structure for asset/market/pair data.
 * Looks for common patterns across DeFi dApps.
 */
function findAssets(
  data: any,
  assets: Set<string>,
  markets: any[],
  configs: any[],
  depth = 0,
): void {
  if (depth > 5 || !data) return;

  // Pattern 1: Array of objects with symbol/pair/name fields
  if (Array.isArray(data) && data.length > 2) {
    const sample = data[0];
    if (sample && typeof sample === 'object') {
      const keys = Object.keys(sample);
      const hasAssetField = keys.some(k =>
        /^(symbol|pair|name|market|asset|ticker|token|currency|base|from)$/i.test(k)
      );
      const hasPriceField = keys.some(k =>
        /^(price|last|mark|index|mid|close|open|bid|ask)$/i.test(k)
      );
      const hasConfigField = keys.some(k =>
        /^(leverage|margin|fee|spread|funding|minSize|maxSize|lotSize|tick)$/i.test(k)
      );

      if (hasAssetField) {
        for (const item of data) {
          // Extract the asset identifier
          const assetName =
            item.symbol || item.pair || item.name || item.market ||
            item.asset || item.ticker || item.from;
          if (typeof assetName === 'string' && assetName.length >= 3 && assetName.length <= 30) {
            assets.add(assetName);
          }

          // If it has price/config data, it's a market definition
          if (hasPriceField || hasConfigField) {
            markets.push(item);
          }
        }
      }

      // Pattern 2: Config objects with leverage/fee info
      if (hasConfigField && !hasAssetField) {
        configs.push(...data);
      }
    }

    // Pattern 3: Simple string arrays that look like asset lists
    if (typeof data[0] === 'string') {
      const looksLikeAssets = data.filter((s: string) =>
        typeof s === 'string' && /^[A-Z]{2,10}[-/][A-Z]{2,10}$/.test(s)
      );
      if (looksLikeAssets.length > 2) {
        for (const a of looksLikeAssets) assets.add(a);
      }
    }
  }

  // Recurse into objects
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const value of Object.values(data)) {
      findAssets(value, assets, markets, configs, depth + 1);
    }
  }
}
