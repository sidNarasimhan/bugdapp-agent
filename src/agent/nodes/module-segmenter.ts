import type { KnowledgeGraph } from '../state.js';

export interface Module {
  id: string;
  name: string;
  pageId: string;
  description: string;
  components: string[];
  flows: string[];
  constraints: string[];
  features: string[];
  assets: string[];
}

/**
 * Segments the KG into testable modules.
 * Uses functional grouping: all components on a page stay together unless
 * the page has clearly distinct sections (tabs = separate views).
 */
export function segmentModules(kg: KnowledgeGraph): Module[] {
  const modules: Module[] = [];

  // Find shared components (nav/header appearing across pages)
  const sharedCompIds = new Set(
    kg.components.filter(c => c.pageId === 'shared').map(c => c.id)
  );

  // Group pages into modules
  for (const page of kg.pages) {
    const pageComps = kg.components.filter(c => c.pageId === page.id);
    if (pageComps.length === 0) continue;

    const pageFlows = kg.flows.filter(f => f.pageId === page.id);
    const hasTabs = pageComps.some(c => c.role === 'tab');
    const hasForm = pageComps.some(c => c.role === 'spinbutton' || c.role === 'slider' || c.role === 'textbox');
    const hasAssets = kg.assets.length > 0 && pageComps.some(c => /[A-Z]{2,}-[A-Z]{2,}/.test(c.name));

    // If page has BOTH a complex form AND tabs, split into form + tabs
    if (hasForm && hasTabs) {
      const formComps = pageComps.filter(c =>
        c.role !== 'tab' && c.role !== 'link'
      );
      const tabComps = pageComps.filter(c =>
        c.role === 'tab' || c.role === 'link'
      );

      modules.push({
        id: `module:${page.name}:main`,
        name: `${page.name} - Main`,
        pageId: page.id,
        description: `Primary functionality on ${page.name}: forms, inputs, buttons, toggles, selectors`,
        components: formComps.map(c => c.id),
        flows: pageFlows.map(f => f.id),
        constraints: kg.constraints.map(c => c.id),
        features: kg.features.map(f => f.id),
        assets: hasAssets ? kg.assets.map(a => a.id) : [],
      });

      if (tabComps.length >= 2) {
        modules.push({
          id: `module:${page.name}:views`,
          name: `${page.name} - Views`,
          pageId: page.id,
          description: `Tab navigation and content views on ${page.name}`,
          components: tabComps.map(c => c.id),
          flows: [],
          constraints: [],
          features: [],
          assets: [],
        });
      }
    } else {
      // Single module for the whole page
      modules.push({
        id: `module:${page.name}`,
        name: page.name,
        pageId: page.id,
        description: `All functionality on ${page.name} (${pageComps.length} components)`,
        components: pageComps.map(c => c.id),
        flows: pageFlows.map(f => f.id),
        constraints: kg.constraints.map(c => c.id),
        features: kg.features.map(f => f.id),
        assets: hasAssets ? kg.assets.map(a => a.id) : [],
      });
    }
  }

  // Navigation module from shared components
  const navComps = kg.components.filter(c => c.pageId === 'shared');
  if (navComps.length > 0) {
    modules.push({
      id: 'module:navigation',
      name: 'Navigation',
      pageId: 'shared',
      description: 'Cross-page navigation, header elements',
      components: navComps.map(c => c.id),
      flows: [],
      constraints: [],
      features: [],
      assets: [],
    });
  }

  return modules;
}
