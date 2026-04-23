import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType } from '../state.js';
import type { KGPage, KGComponent, KGAction, KGFlow, KGFlowStep, KGEdge, KGFeature, KGAsset, KGDropdownOption, KGDocSection, KGApiEndpoint, KGConstraint, KnowledgeGraph } from '../state.js';
import { emptyKnowledgeGraph } from '../state.js';
import { crawlDApp } from '../../phases/context.js';
import type { BrowserCtx } from '../../types.js';
import { extractContracts } from '../chain/contract-extractor.js';

/**
 * Crawler node — wraps existing crawlDApp, populates knowledge graph.
 * No LLM. Deterministic. $0.
 */
export function createCrawlerNode(browserCtx: BrowserCtx) {
  return async (state: AgentStateType) => {
    const { config } = state;
    const outputDir = config.outputDir;
    mkdirSync(join(outputDir, 'screenshots'), { recursive: true });

    // Check for cached crawl data
    const cachedScraped = join(outputDir, 'scraped-data.json');
    const cachedContext = join(outputDir, 'context.json');
    if (existsSync(cachedScraped) && existsSync(cachedContext)) {
      console.log('━━━ Crawler: Loading cached data ━━━');
      const crawlResult = loadCachedCrawl(outputDir);
      const kg = buildKGFromCrawl(crawlResult, config.url);
      console.log(`[Crawler] Cached KG: ${kg.pages.length} pages, ${kg.components.length} components, ${kg.actions.length} actions, ${kg.flows.length} flows`);
      return { crawlData: crawlResult, knowledgeGraph: kg };
    }

    console.log('━━━ Crawler: Scraping dApp ━━━');
    const crawlResult = await crawlDApp(browserCtx, config.url);

    // Persist raw crawl artifacts
    writeFileSync(join(outputDir, 'context.json'), JSON.stringify(crawlResult.context, null, 2));
    if (crawlResult.scrapedData) {
      writeFileSync(join(outputDir, 'scraped-data.json'), JSON.stringify(crawlResult.scrapedData, null, 2));
    }
    if (crawlResult.networkData?.rawApiData) {
      writeFileSync(join(outputDir, 'network-raw-apis.json'), JSON.stringify(crawlResult.networkData.rawApiData, null, 2));
    }
    if (crawlResult.interactions?.length > 0) {
      writeFileSync(join(outputDir, 'interactions.json'), JSON.stringify(crawlResult.interactions, null, 2));
    }
    if (crawlResult.discoveredFlows?.length > 0) {
      writeFileSync(join(outputDir, 'discovered-flows.json'), JSON.stringify(crawlResult.discoveredFlows, null, 2));
    }
    if (crawlResult.bundleAnalysis) {
      writeFileSync(join(outputDir, 'bundle-analysis.json'), JSON.stringify(crawlResult.bundleAnalysis, null, 2));
    }

    // Build knowledge graph from crawl data
    const kg = buildKGFromCrawl(crawlResult, config.url);

    const pageCount = kg.pages.length;
    const componentCount = kg.components.length;
    const actionCount = kg.actions.length;
    const flowCount = kg.flows.length;
    console.log(`[Crawler] KG: ${pageCount} pages, ${componentCount} components, ${actionCount} actions, ${flowCount} flows`);

    return {
      crawlData: crawlResult,
      knowledgeGraph: kg,
    };
  };
}

function loadCachedCrawl(outputDir: string): any {
  const context = JSON.parse(readFileSync(join(outputDir, 'context.json'), 'utf-8'));
  const scrapedData = JSON.parse(readFileSync(join(outputDir, 'scraped-data.json'), 'utf-8'));
  const interactions = existsSync(join(outputDir, 'interactions.json'))
    ? JSON.parse(readFileSync(join(outputDir, 'interactions.json'), 'utf-8')) : [];
  const discoveredFlows = existsSync(join(outputDir, 'discovered-flows.json'))
    ? JSON.parse(readFileSync(join(outputDir, 'discovered-flows.json'), 'utf-8')) : [];
  const networkData = {
    rawApiData: existsSync(join(outputDir, 'network-raw-apis.json'))
      ? JSON.parse(readFileSync(join(outputDir, 'network-raw-apis.json'), 'utf-8')) : {},
    responses: [], assets: [], markets: [], configs: [],
  };
  const bundleAnalysis = existsSync(join(outputDir, 'bundle-analysis.json'))
    ? JSON.parse(readFileSync(join(outputDir, 'bundle-analysis.json'), 'utf-8')) : undefined;
  return { context, scrapedData, interactions, discoveredFlows, networkData, bundleAnalysis };
}

function buildKGFromCrawl(crawl: any, baseUrl: string): KnowledgeGraph {
  const kg = emptyKnowledgeGraph();
  const scrapedData = crawl.scrapedData || {};
  const interactions = crawl.interactions || [];
  const discoveredFlows = crawl.discoveredFlows || [];

  // Detect shared elements across pages (nav, header, etc.)
  const elementsByName = new Map<string, Set<string>>();
  for (const [path, data] of Object.entries(scrapedData) as [string, any][]) {
    for (const el of data.elements || []) {
      if (!el.name) continue;
      if (!elementsByName.has(el.name)) elementsByName.set(el.name, new Set());
      elementsByName.get(el.name)!.add(path);
    }
  }
  const sharedNames = new Set<string>();
  for (const [name, pages] of elementsByName) {
    if (pages.size >= 2) sharedNames.add(name);
  }
  const addedShared = new Set<string>();

  // Pages
  for (const [path, data] of Object.entries(scrapedData) as [string, any][]) {
    const pageId = `page:${path || '/'}`;
    kg.pages.push({
      id: pageId,
      url: path,
      name: path.replace(/^\//, '') || 'Home',
      title: data.visibleText?.slice(0, 100) || '',
      elementCount: data.elements?.length || 0,
      walletRequired: false,
    });

    // Components from page elements — DEDUPLICATE shared elements
    if (data.elements) {
      for (let i = 0; i < data.elements.length; i++) {
        const el = data.elements[i];

        // Skip shared elements after first occurrence
        if (el.name && sharedNames.has(el.name)) {
          if (addedShared.has(el.name)) continue;
          addedShared.add(el.name);
          // Add as shared component (not page-specific)
          const compId = `comp:shared:${el.role}:${el.name}`;
          kg.components.push({
            id: compId,
            pageId: 'shared',
            role: el.role || 'unknown',
            name: el.name || '',
            selector: buildSelector(el),
            testId: el.testId,
            disabled: !!el.disabled,
            dynamic: isDynamic(el.name),
          });
          continue;
        }

        const compId = `comp:${path}:${el.role}:${el.name || i}`;
        kg.components.push({
          id: compId,
          pageId,
          role: el.role || 'unknown',
          name: el.name || '',
          selector: buildSelector(el),
          testId: el.testId,
          disabled: !!el.disabled,
          dynamic: isDynamic(el.name),
        });
        kg.edges.push({ from: pageId, to: compId, relationship: 'contains' });
      }
    }

    // Dropdown contents as components
    if (data.dropdownContents) {
      for (const [ddName, options] of Object.entries(data.dropdownContents) as [string, string[]][]) {
        for (const opt of options) {
          const optId = `comp:${path}:option:${ddName}:${opt}`;
          kg.components.push({
            id: optId,
            pageId,
            role: 'option',
            name: opt,
            selector: `getByRole('option', { name: '${opt}' })`,
            disabled: false,
            dynamic: false,
          });
        }
      }
    }
  }

  // Actions from interactions
  for (const ix of interactions) {
    const pageId = `page:${ix.page || '/'}`;
    const compId = `comp:${ix.page}:${ix.elementRole}:${ix.elementName || 'unnamed'}`;
    const actionId = `action:${ix.page}:${ix.elementRole}:${ix.elementName}:${ix.action}`;

    kg.actions.push({
      id: actionId,
      componentId: compId,
      type: ix.action || 'click',
      value: ix.value,
      resultDescription: ix.domChanges
        ? `${ix.domChanges.appeared?.length || 0} appeared, ${ix.domChanges.disappeared?.length || 0} disappeared`
        : 'no change',
      newElementsAppeared: ix.domChanges?.appeared || [],
      elementsDisappeared: ix.domChanges?.disappeared || [],
      triggersWallet: ix.walletInteraction || false,
      success: ix.success !== false,
    });
    kg.edges.push({ from: compId, to: actionId, relationship: 'triggers' });
  }

  // Flows from discovered flows
  for (const flow of discoveredFlows) {
    const flowId = `flow:${flow.id || flow.name}`;
    const steps: KGFlowStep[] = (flow.steps || []).map((s: any, i: number) => ({
      order: i,
      description: `${s.action} ${s.elementRole} "${s.elementName}"${s.value ? ` with "${s.value}"` : ''}`,
      expectedOutcome: s.resultDescription || 'UI updates',
      selector: buildSelectorFromStep(s),
    }));

    kg.flows.push({
      id: flowId,
      name: flow.name || `Flow ${flow.id}`,
      description: `${steps.length}-step flow on ${flow.page}`,
      pageId: `page:${flow.page || '/'}`,
      steps,
      requiresFundedWallet: flow.walletInteraction || false,
      category: categorizeFlow(flow.name, flow.page),
      priority: flow.walletInteraction ? 1 : 2,
      tested: false,
      testResult: 'untested',
    });
  }

  // Build synthetic flows from interaction patterns
  buildSyntheticFlows(kg, scrapedData, interactions);

  // ── Docs → Features + DocSections ──
  // context.ts's deepCrawlDocs concatenates pages with `=== <title> (<url>) ===`
  // or `=== <url> ===` markers. We split on those so each crawled docs page
  // becomes a section. Falls back to markdown-heading splitting if the doc
  // payload has that shape instead. Plain text input with neither marker
  // becomes a single section.
  const docsContent = crawl.context?.docsContent || '';
  if (docsContent) {
    const sections = splitDocsIntoSections(docsContent);
    for (let i = 0; i < sections.length; i++) {
      const { title, content } = sections[i];
      if (content.trim().length < 50) continue;
      const keywords = extractKeywords(content);

      kg.docSections.push({
        id: `doc:${i}`,
        title,
        content: content.slice(0, 2000),
        keywords,
      });

      // Extract features from doc sections
      if (/feature|mode|option|type|tool/i.test(title)) {
        kg.features.push({
          id: `feature:doc:${i}`,
          name: title,
          description: content.slice(0, 500),
          constraints: extractConstraints(content),
        });
      }
    }
    console.log(`[KG] Docs → ${kg.docSections.length} sections, ${kg.features.length} features`);
  }

  // Extract features from context.features — match with doc sections for real descriptions
  const ctxFeatures = crawl.context?.features || [];
  for (const f of ctxFeatures) {
    if (!kg.features.find(x => x.name.toLowerCase() === f.toLowerCase())) {
      // Try to find a matching doc section for a real description
      const matchingDoc = kg.docSections.find(d =>
        d.title.toLowerCase().includes(f.toLowerCase()) ||
        d.keywords.some(k => k === f.toLowerCase())
      );
      kg.features.push({
        id: `feature:ctx:${f}`,
        name: f,
        description: matchingDoc ? matchingDoc.content.slice(0, 300) : f,
      });
    }
  }

  // ── Constraints from docs ──
  if (docsContent) {
    kg.constraints.push(...extractConstraintsFromDocs(docsContent));
  }

  // ── API data → Assets ──
  const rawApiData = crawl.networkData?.rawApiData || {};
  for (const [path, body] of Object.entries(rawApiData) as [string, any][]) {
    // Extract assets from socket/market data
    if (body?.data?.pairInfos && body?.data?.groupInfo) {
      const groupInfo = body.data.groupInfo;
      for (const [, pair] of Object.entries(body.data.pairInfos) as [string, any][]) {
        if (!pair.from || pair.from === '') continue;
        const symbol = `${pair.from}-${pair.to}`;
        const groupName = groupInfo[pair.groupIndex]?.name || 'Unknown';
        const maxLev = groupInfo[pair.groupIndex]?.maxLeverage;

        if (!kg.assets.find(a => a.symbol === symbol)) {
          kg.assets.push({
            id: `asset:${symbol}`,
            symbol,
            group: groupName,
            maxLeverage: maxLev ? Number(maxLev) / 1e10 : undefined,
          });
        }
      }
    }

    // Store API endpoint summary (skip noisy ones)
    if (!/flags|initialize|wallets|logs|sanctions|ip_address|version/.test(path)) {
      const sampleKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [];
      if (sampleKeys.length > 0) {
        kg.apiEndpoints.push({
          id: `api:${path}`,
          path,
          description: describeApiResponse(path, body),
          sampleKeys,
        });
      }
    }
  }

  // ── Dropdown options ──
  for (const [path, data] of Object.entries(scrapedData) as [string, any][]) {
    if (data.dropdownContents) {
      for (const [ddName, options] of Object.entries(data.dropdownContents) as [string, string[]][]) {
        const compId = `comp:${path}:combobox:${ddName}`;
        for (let i = 0; i < options.length; i++) {
          kg.dropdownOptions.push({
            id: `dd:${path}:${ddName}:${i}`,
            componentId: compId,
            value: options[i],
            index: i,
          });
        }
      }
    }
  }

  // ── Contract addresses from docs + network payloads ──
  // Deterministic, no LLM. Role-inferred from surrounding text. Chain inferred
  // from the dApp profile when available — otherwise left undefined.
  try {
    let defaultChainId: number | undefined;
    try {
      // Lazy-import to avoid a cycle if profiles import anything crawler-adjacent.
      const { getProfileOrThrow } = require('../profiles/registry.js');
      defaultChainId = getProfileOrThrow(baseUrl)?.network?.chainId;
    } catch { /* no profile match */ }

    const contracts = extractContracts({
      docsContent: crawl.context?.docsContent || '',
      rawApiData: crawl.networkData?.rawApiData || {},
      bundleText: crawl.bundleAnalysis ? JSON.stringify(crawl.bundleAnalysis).slice(0, 200_000) : undefined,
      defaultChainId,
    });
    kg.contracts = contracts;
    if (contracts.length > 0) {
      const byRole: Record<string, number> = {};
      for (const c of contracts) byRole[c.role ?? 'other'] = (byRole[c.role ?? 'other'] ?? 0) + 1;
      const summary = Object.entries(byRole).map(([r, n]) => `${r}:${n}`).join(', ');
      console.log(`[KG] Contracts → ${contracts.length} addresses (${summary})`);
    }
  } catch (e) {
    console.warn(`[KG] contract extraction failed: ${(e as Error).message}`);
    kg.contracts = [];
  }

  return kg;
}

function buildSelector(el: any): string {
  if (el.testId) return `getByTestId('${el.testId}')`;
  const cleanName = el.name?.replace(/^\(unnamed .*\)$/, '');
  if (el.role && cleanName) return `getByRole('${el.role}', { name: '${cleanName.replace(/'/g, "\\'")}' })`;
  if (cleanName) return `getByText('${cleanName.replace(/'/g, "\\'")}')`;
  // No usable name — use role-only selector (caller should add .first()/.nth() as needed)
  return `getByRole('${el.role || 'generic'}')`;
}

function buildSelectorFromStep(s: any): string {
  if (s.elementRole && s.elementName) return `getByRole('${s.elementRole}', { name: '${s.elementName}' })`;
  return '';
}

function isDynamic(name: string): boolean {
  if (!name) return false;
  return /\d+\.\d{2,}|\$[\d,]+|0x[a-f0-9]{4,}/i.test(name);
}

/**
 * Categorize a discovered flow into a generic web3 category. The categories are
 * dApp-class agnostic — covers swap / perps / lending / staking / yield / CDP /
 * bridge / NFT / launchpad without hardcoding any particular protocol's wording.
 */
function categorizeFlow(name: string, page: string): string {
  const n = (name + ' ' + page).toLowerCase();
  if (/wallet|connect|login|sign|approve/.test(n)) return 'wallet';
  if (/swap|exchange|trade|order|long|short|buy|sell|perps?\b|leverage/.test(n)) return 'trading';
  if (/supply|borrow|repay|withdraw|lend|collateral|health/.test(n)) return 'lending';
  if (/stake|unstake|delegate|validator|reward|claim/.test(n)) return 'staking';
  if (/vault|yield|farm|harvest|compound|lp\b|liquidity/.test(n)) return 'yield';
  if (/mint|redeem|burn|issue|vault.*debt|cdp/.test(n)) return 'cdp';
  if (/bridge|cross.?chain|source.*chain|destination.*chain/.test(n)) return 'bridge';
  if (/portfolio|position|pnl|balance|history/.test(n)) return 'portfolio';
  if (/referral|refer|quest|campaign/.test(n)) return 'referral';
  if (/leaderboard|ranking|stats/.test(n)) return 'leaderboard';
  if (/govern|vote|proposal|ballot/.test(n)) return 'governance';
  return 'navigation';
}

/**
 * Split a concatenated docs blob into (title, content) sections.
 * Prefers `=== <title> ===` and `=== <title> (<url>) ===` boundaries that our
 * own crawler emits. Falls back to markdown-heading splits, then to a single
 * section if nothing else matches.
 */
function splitDocsIntoSections(docs: string): { title: string; content: string }[] {
  const sections: { title: string; content: string }[] = [];

  // Primary strategy — split on our own `===` boundary lines.
  const markerRegex = /^\s*=== (.+?) ===\s*$/gm;
  const markers: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(docs)) !== null) {
    markers.push({ title: cleanDocsTitle(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (markers.length > 0) {
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].end;
      const end = i + 1 < markers.length ? markers[i + 1].start : docs.length;
      sections.push({ title: markers[i].title, content: docs.slice(start, end).trim() });
    }
    return sections;
  }

  // Fallback — markdown heading split.
  const mdSplit = docs.split(/(?=^#{1,3}\s)/m).filter(s => s.trim().length > 50);
  if (mdSplit.length > 1) {
    for (let i = 0; i < mdSplit.length; i++) {
      const section = mdSplit[i].trim();
      const titleMatch = section.match(/^#{1,3}\s*(.+)/);
      const title = titleMatch ? titleMatch[1].trim() : `Section ${i + 1}`;
      const content = section.slice(title.length + 4).trim();
      sections.push({ title, content });
    }
    return sections;
  }

  // Last resort — one section covering the entire blob.
  if (docs.trim().length > 0) {
    sections.push({ title: 'Documentation', content: docs.trim() });
  }
  return sections;
}

/** Strip a URL suffix from a docs title marker: "Overview (https://…)" → "Overview". */
function cleanDocsTitle(raw: string): string {
  const urlParen = raw.match(/^(.+?)\s*\((https?:\/\/[^)]+)\)\s*$/);
  if (urlParen) return urlParen[1].trim();
  // If the whole title IS a URL, convert to something human-readable.
  try {
    const u = new URL(raw);
    const last = u.pathname.replace(/\/$/, '').split('/').pop();
    return last && last.length > 0 ? last.replace(/[-_]/g, ' ') : u.hostname;
  } catch {
    return raw.trim();
  }
}

function extractConstraintsFromDocs(docs: string): KGConstraint[] {
  const constraints: KGConstraint[] = [];
  const lines = docs.split('\n');

  // Pattern-based constraint extraction
  const patterns: { regex: RegExp; name: string; scopeHint?: string }[] = [
    { regex: /(\d+)x\s*(?:max(?:imum)?)?\s*leverage/i, name: 'Max leverage' },
    { regex: /max(?:imum)?\s*leverage\s*(?:of\s*|:?\s*)(\d+)x/i, name: 'Max leverage' },
    { regex: /liquidat(?:ion|ed?)\s*(?:at|when|threshold)?\s*(\d+)%/i, name: 'Liquidation threshold' },
    { regex: /min(?:imum)?\s*(?:collateral|position|trade)\s*(?:size|amount)?\s*(?:of\s*|:?\s*)\$?(\d+[\d,.]*)/i, name: 'Minimum position' },
    { regex: /max(?:imum)?\s*(?:profit|gain)\s*(?:cap|limit)?\s*(?:of\s*|:?\s*)(\d+[\d,.]*%?)/i, name: 'Max profit cap' },
    { regex: /max(?:imum)?\s*(?:trades?|positions?)\s*(?:per\s*(?:pair|asset|wallet))?\s*(?:of\s*|:?\s*)(\d+)/i, name: 'Max trades per pair' },
    { regex: /min(?:imum)?\s*(?:trade\s*)?duration\s*(?:of\s*|:?\s*)(\d+)\s*(?:min|sec|hour)/i, name: 'Min trade duration' },
    { regex: /(\d+)%\s*(?:of\s*)?(?:open\s*interest|OI)\s*(?:cap|limit|max)/i, name: 'OI cap per wallet' },
    { regex: /market\s*hours?[:\s]+(\w[\w\s]*?\d+\s*(?:AM|PM)\s*(?:ET|UTC)\s*to\s*\w+\s*\d+\s*(?:AM|PM)\s*(?:ET|UTC))/i, name: 'Market hours' },
    { regex: /(?:fee|cost)\s*(?:of\s*|:?\s*)(\d+[\d.]*%?\s*(?:of\s*\w+)?)/i, name: 'Trading fee' },
    { regex: /slippage\s*(?:tolerance|max|limit)?\s*(?:of\s*|:?\s*)(\d+[\d.]*%)/i, name: 'Slippage tolerance' },
  ];

  const fullText = docs;

  for (const { regex, name, scopeHint } of patterns) {
    const matches = fullText.matchAll(new RegExp(regex, 'gi'));
    for (const match of matches) {
      const value = match[1] || match[0];
      // Get surrounding context for scope
      const idx = match.index || 0;
      const surrounding = fullText.slice(Math.max(0, idx - 100), idx + 200);

      // Determine scope from context. Generic signals across archetypes — perps
      // variations, asset classes, lending markets, staking pools, etc. No hard
      // coding of any particular dApp's wording.
      let scope = scopeHint || 'all';
      // Capture a preceding heading if one is close (e.g., "## Perps → 250x max leverage")
      const headingMatch = surrounding.match(/(?:^|\n)#{1,3}\s*(.+?)\s*(?:\n|$)/);
      if (headingMatch) {
        scope = headingMatch[1].slice(0, 60);
      } else if (/zero.?fee|ZFP/i.test(surrounding)) scope = 'Zero Fee Perps';
      else if (/forex/i.test(surrounding)) scope = 'Forex';
      else if (/crypto/i.test(surrounding)) scope = 'Crypto';
      else if (/equit/i.test(surrounding)) scope = 'Equities';
      else if (/commodit/i.test(surrounding)) scope = 'Commodities';
      else if (/stable(?:coin)?/i.test(surrounding)) scope = 'Stablecoins';
      else if (/lending|borrow|supply/i.test(surrounding)) scope = 'Lending';
      else if (/stak(?:e|ing)/i.test(surrounding)) scope = 'Staking';
      else if (/swap|AMM|DEX/i.test(surrounding)) scope = 'Swap';

      const id = `constraint:${name.toLowerCase().replace(/\s+/g, '-')}:${constraints.length}`;
      const cleanValue = value.trim().slice(0, 100);
      if (!constraints.find(c => c.name === name && c.value === cleanValue && c.scope === scope)) {
        constraints.push({
          id,
          name,
          value: cleanValue,
          scope,
          testImplication: generateTestImplication(name, cleanValue, scope),
          source: 'docs',
        });
      }
    }
  }

  return constraints;
}

function generateTestImplication(name: string, value: string, scope: string): string {
  const scopeText = scope === 'all' ? '' : ` (${scope})`;
  switch (name) {
    case 'Max leverage': return `Test placing order at ${value} leverage${scopeText} — should succeed. Test at higher — should be rejected.`;
    case 'Liquidation threshold': return `Open position and verify liquidation price is calculated at ${value} health ratio${scopeText}.`;
    case 'Minimum position': return `Test placing order below ${value}${scopeText} — should show validation error.`;
    case 'Max profit cap': return `Verify profit display is capped at ${value}${scopeText} for winning positions.`;
    case 'Max trades per pair': return `Open ${value} positions on same pair${scopeText} — next should be rejected.`;
    case 'Min trade duration': return `Open and immediately try to close position${scopeText} — should show minimum duration warning.`;
    case 'OI cap per wallet': return `Test opening position that exceeds ${value} of asset OI${scopeText} — should be restricted.`;
    case 'Market hours': return `Test trading${scopeText} outside ${value} — should be blocked or show warning.`;
    case 'Trading fee': return `Verify fee display shows ${value}${scopeText} before order confirmation.`;
    case 'Slippage tolerance': return `Test order with price movement exceeding ${value}${scopeText} — should warn or reject.`;
    default: return `Test boundary at ${value}${scopeText}.`;
  }
}

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const freq = new Map<string, number>();
  const stopwords = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'will', 'your', 'more', 'also', 'when', 'each', 'into', 'than', 'they', 'which', 'their', 'about', 'would', 'there', 'other']);
  for (const w of words) {
    if (!stopwords.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
}

function extractConstraints(text: string): string | undefined {
  const constraints: string[] = [];
  const minMatch = text.match(/min(?:imum)?\s*(?:of\s*)?([\d,.]+\s*\w+)/gi);
  const maxMatch = text.match(/max(?:imum)?\s*(?:of\s*)?([\d,.]+\s*\w+)/gi);
  const requireMatch = text.match(/requires?\s+([^.]+)/gi);
  if (minMatch) constraints.push(...minMatch.map(m => m.trim()));
  if (maxMatch) constraints.push(...maxMatch.map(m => m.trim()));
  if (requireMatch) constraints.push(...requireMatch.slice(0, 2).map(m => m.trim()));
  return constraints.length > 0 ? constraints.join('; ') : undefined;
}

function describeApiResponse(path: string, body: any): string {
  if (!body || typeof body !== 'object') return 'Unknown response';
  if (body.data?.pairInfos) return `Market data: ${Object.keys(body.data.pairInfos).length} trading pairs`;
  if (body.data?.groupInfo) return `Group config: ${Object.keys(body.data.groupInfo).length} groups`;
  if (Array.isArray(body)) return `Array of ${body.length} items`;
  const keys = Object.keys(body).slice(0, 5);
  return `Object with keys: ${keys.join(', ')}`;
}

function buildSyntheticFlows(kg: KnowledgeGraph, scrapedData: any, interactions: any[]): void {
  // Group interactions by page to detect form-submit patterns
  const byPage = new Map<string, any[]>();
  for (const ix of interactions) {
    const page = ix.page || '/';
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(ix);
  }

  for (const [page, ixs] of byPage) {
    // Find input + button combinations (form flows)
    const inputs = ixs.filter((ix: any) => ix.action === 'type' || ix.elementRole === 'spinbutton' || ix.elementRole === 'textbox');
    const buttons = ixs.filter((ix: any) => ix.action === 'click' && ix.elementRole === 'button' && ix.success);

    if (inputs.length > 0 && buttons.length > 0) {
      const flowId = `flow:synthetic:form:${page}`;
      if (!kg.flows.find(f => f.id === flowId)) {
        const steps: KGFlowStep[] = [
          ...inputs.map((inp: any, i: number) => ({
            order: i,
            description: `Type into ${inp.elementName || 'input'}`,
            expectedOutcome: 'Value entered',
            selector: buildSelectorFromStep(inp),
          })),
          {
            order: inputs.length,
            description: `Click ${buttons[0].elementName || 'submit'}`,
            expectedOutcome: buttons[0].domChanges?.appeared?.length
              ? `${buttons[0].domChanges.appeared.length} new elements`
              : 'Form submitted',
            selector: buildSelectorFromStep(buttons[0]),
          },
        ];
        kg.flows.push({
          id: flowId,
          name: `Form submission on ${page}`,
          description: `Fill ${inputs.length} inputs and submit`,
          pageId: `page:${page}`,
          steps,
          requiresFundedWallet: false,
          category: categorizeFlow('', page),
          priority: 2,
          tested: false,
          testResult: 'untested',
        });
      }
    }
  }
}
