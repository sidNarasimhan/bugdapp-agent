import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, KnowledgeGraph } from '../state.js';
import { DAppGraph } from '../state.js';

/**
 * Builds a dApp-specific context summary from the KG.
 * This summary gets injected into all agent prompts so they understand
 * the specific dApp they're testing — without hardcoding anything.
 */
export function createContextBuilderNode() {
  return async (state: AgentStateType) => {
    const { config, knowledgeGraph: kg } = state;

    console.log('━━━ Context Builder: Generating dApp profile ━━━');

    // Use real graph for flow info
    const graph = DAppGraph.deserialize(state.graph);
    const computedFlows = graph.getAllFlows();

    const profile = buildDAppProfile(kg, graph, computedFlows);
    writeFileSync(join(config.outputDir, 'dapp-profile.md'), profile);
    console.log(`[Context] dApp profile: ${profile.length} chars (${computedFlows.length} graph flows)`);

    // Store profile in crawlData so all agents can access it
    return {
      crawlData: {
        ...state.crawlData,
        dappProfile: profile,
      },
    };
  };
}

function buildDAppProfile(kg: KnowledgeGraph, graph: DAppGraph, computedFlows: import('../state.js').ComputedFlow[]): string {
  const sections: string[] = [];

  // Header
  const mainPage = kg.pages[0];
  sections.push(`# dApp Profile: ${mainPage?.title || 'Unknown'}`);
  sections.push(`Pages: ${kg.pages.map(p => `${p.name} (${p.url})`).join(', ')}`);

  // Features
  if (kg.features.length > 0) {
    sections.push('\n## Features');
    for (const f of kg.features) {
      sections.push(`- **${f.name}**: ${f.description.slice(0, 300)}`);
      if (f.constraints) sections.push(`  Constraints: ${f.constraints}`);
    }
  }

  // Assets / Items
  if (kg.assets.length > 0) {
    const groups = new Map<string, typeof kg.assets>();
    for (const a of kg.assets) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group)!.push(a);
    }
    sections.push(`\n## Available Assets (${kg.assets.length} total)`);
    for (const [group, assets] of groups) {
      const examples = assets.slice(0, 5).map(a =>
        `${a.symbol}${a.maxLeverage ? ` (max ${a.maxLeverage}x)` : ''}`
      );
      sections.push(`- **${group}** (${assets.length}): ${examples.join(', ')}${assets.length > 5 ? '...' : ''}`);
    }
  }

  // Interactive Components Summary
  if (kg.components.length > 0) {
    const byRole = new Map<string, number>();
    for (const c of kg.components) {
      byRole.set(c.role, (byRole.get(c.role) || 0) + 1);
    }
    sections.push(`\n## UI Components (${kg.components.length} total)`);
    sections.push([...byRole.entries()].map(([role, count]) => `${count} ${role}s`).join(', '));

    // Key interactive components (non-trivial ones)
    const keyComponents = kg.components.filter(c =>
      c.name && !c.disabled && ['button', 'switch', 'slider', 'combobox', 'spinbutton', 'tab'].includes(c.role)
    );
    if (keyComponents.length > 0) {
      sections.push('\nKey components:');
      const byPage = new Map<string, typeof keyComponents>();
      for (const c of keyComponents) {
        if (!byPage.has(c.pageId)) byPage.set(c.pageId, []);
        byPage.get(c.pageId)!.push(c);
      }
      for (const [pageId, comps] of byPage) {
        sections.push(`  ${pageId}:`);
        for (const c of comps.slice(0, 20)) {
          sections.push(`    - ${c.role} "${c.name}" → ${c.selector}`);
        }
      }
    }
  }

  // Dropdown Options
  if (kg.dropdownOptions.length > 0) {
    const byDropdown = new Map<string, string[]>();
    for (const d of kg.dropdownOptions) {
      if (!byDropdown.has(d.componentId)) byDropdown.set(d.componentId, []);
      byDropdown.get(d.componentId)!.push(d.value);
    }
    sections.push('\n## Dropdown Options');
    for (const [comp, opts] of byDropdown) {
      sections.push(`- ${comp}: ${opts.join(', ')}`);
    }
  }

  // Computed Flows from Graph Traversal
  if (computedFlows.length > 0) {
    sections.push('\n## User Flows (from graph traversal)');
    for (const f of computedFlows) {
      const steps = f.path.map(n => `${n.label}${n.selector ? ` → page.${n.selector}` : ''}`).join(' → ');
      sections.push(`- **${f.name}**${f.requiresFundedWallet ? ' 💰' : ''}`);
      sections.push(`  Path: ${steps}`);
      if (f.permutations?.length) {
        sections.push(`  Variations: ${f.permutations.map(p => `${p.field} (${p.options.join('/')})`).join(', ')}`);
      }
      if (f.constraints.length > 0) {
        sections.push(`  Constraints: ${f.constraints.map(c => `${c.name}=${c.value}`).join(', ')}`);
      }
    }
  }

  // Explorer-verified Flows
  if (kg.flows.length > 0) {
    sections.push('\n## Explorer-Verified Flows');
    for (const f of kg.flows) {
      sections.push(`- **${f.name}** [${f.category}]`);
      sections.push(`  Steps: ${f.steps.map(s => s.description).join(' → ')}`);
    }
  }

  // Graph stats
  sections.push(`\n## Graph Stats`);
  sections.push(`- ${graph.stats.nodes} nodes, ${graph.stats.edges} edges`);
  sections.push(`- ${computedFlows.length} computed flows`);
  sections.push(`- ${graph.getUnconnectedComponents().length} unexplored components`);

  // Constraints & Business Rules
  if (kg.constraints.length > 0) {
    sections.push('\n## Constraints & Business Rules');
    for (const c of kg.constraints) {
      sections.push(`- **${c.name}**: ${c.value}${c.scope && c.scope !== 'all' ? ` (${c.scope})` : ''}`);
      sections.push(`  → Test: ${c.testImplication}`);
    }
  }

  // Documentation highlights
  if (kg.docSections.length > 0) {
    sections.push('\n## Documentation');
    for (const d of kg.docSections.slice(0, 8)) {
      sections.push(`### ${d.title}`);
      sections.push(d.content.slice(0, 500));
    }
  }

  // API data
  if (kg.apiEndpoints.length > 0) {
    sections.push('\n## API Endpoints');
    for (const a of kg.apiEndpoints.slice(0, 10)) {
      sections.push(`- ${a.path}: ${a.description}`);
    }
  }

  return sections.join('\n');
}
