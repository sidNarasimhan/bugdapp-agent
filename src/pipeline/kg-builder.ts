import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType } from '../agent/state.js';
import { DAppGraph, type GraphNode, type GraphEdge, type ComputedFlow } from '../agent/state.js';

/**
 * KG_Builder — constructs a real graph with traversable edges from:
 *   A) Crawler interaction data (click X → Y appeared = REVEALS edges)
 *   B) Single-page form detection (inputs + selectors + toggles + submit = CONFIGURES/SUBMITS edges)
 *   C) Constraint mapping (docs constraints → CONSTRAINS edges to relevant components)
 *   D) Explorer flows (report_flow steps → LEADS_TO chains)
 *
 * Runs after crawler (and after explorer if explorer has run).
 */
export function createKGBuilderNode() {
  return async (state: AgentStateType) => {
    const { knowledgeGraph: kg, config } = state;

    console.log('━━━ KG Builder: Constructing real graph ━━━');

    const graph = new DAppGraph();

    // ── A: Add page nodes and component nodes ──
    for (const page of kg.pages) {
      graph.addNode({
        id: page.id,
        type: 'page',
        label: page.name,
        data: { url: page.url, elementCount: page.elementCount },
      });
    }

    for (const comp of kg.components) {
      graph.addNode({
        id: comp.id,
        type: 'component',
        label: comp.name || `(unnamed ${comp.role})`,
        pageId: comp.pageId,
        selector: comp.selector,
        role: comp.role,
        data: { disabled: comp.disabled, dynamic: comp.dynamic, testId: comp.testId },
      });
      // Page CONTAINS component
      if (comp.pageId) {
        graph.addEdge({ from: comp.pageId, to: comp.id, type: 'CONTAINS' });
      }
    }

    // ── B: Build REVEALS edges from crawler interactions ──
    let revealEdgeCount = 0;
    for (const action of kg.actions) {
      if (!action.success || action.newElementsAppeared.length === 0) continue;

      // The action's component triggered new elements to appear
      const sourceComp = action.componentId;
      if (!graph.nodes.has(sourceComp)) continue;

      // If many elements appeared, they likely belong to a modal/dialog
      if (action.newElementsAppeared.length >= 3) {
        // Create a modal/container node
        const modalId = `modal:${sourceComp}:${revealEdgeCount}`;
        const modalLabel = action.newElementsAppeared.slice(0, 3).join(', ');
        graph.addNode({
          id: modalId,
          type: 'modal',
          label: modalLabel,
          pageId: graph.nodes.get(sourceComp)?.pageId,
        });
        graph.addEdge({ from: sourceComp, to: modalId, type: 'REVEALS', label: `click reveals ${action.newElementsAppeared.length} elements` });

        // Modal contains the revealed elements — match them to existing components
        for (const appeared of action.newElementsAppeared) {
          const matchingComp = findMatchingComponent(kg.components, appeared, graph.nodes.get(sourceComp)?.pageId);
          if (matchingComp) {
            graph.addEdge({ from: modalId, to: matchingComp.id, type: 'CONTAINS' });
          }
        }
        revealEdgeCount++;
      } else {
        // Few elements appeared — direct REVEALS edge
        for (const appeared of action.newElementsAppeared) {
          const matchingComp = findMatchingComponent(kg.components, appeared, graph.nodes.get(sourceComp)?.pageId);
          if (matchingComp) {
            graph.addEdge({ from: sourceComp, to: matchingComp.id, type: 'REVEALS' });
            revealEdgeCount++;
          }
        }
      }
    }
    console.log(`[KG Builder] ${revealEdgeCount} REVEALS edges from interactions`);

    // ── C: Build form flows from component analysis ──
    // A "form" is any page section where the user configures parameters and submits.
    // Detect by looking for: inputs OR sliders OR toggles OR value-selector buttons + a submit button.
    // Also add inputs discovered by explorer (via interaction records with action=type).
    let formCount = 0;
    const pageIds = [...new Set(kg.components.map(c => c.pageId))];

    // Find inputs the explorer discovered by typing (these may not be in the components list)
    const explorerTypedInputs = kg.actions.filter(a => a.type === 'type' && a.success);
    for (const typed of explorerTypedInputs) {
      // Ensure the component exists as a node
      if (!graph.nodes.has(typed.componentId)) {
        const pageId = kg.components.find(c => c.id === typed.componentId)?.pageId || 'page:/trade';
        graph.addNode({
          id: typed.componentId,
          type: 'component',
          label: typed.value ? `input (typed: ${typed.value})` : 'input',
          role: 'spinbutton',
          pageId,
          selector: `getByRole('spinbutton')`,
        });
      }
    }

    for (const pageId of pageIds) {
      if (pageId === 'shared') continue;
      const pageComps = kg.components.filter(c => c.pageId === pageId && !c.disabled);
      // Also include explorer-discovered inputs for this page
      const explorerInputIds = new Set(explorerTypedInputs
        .filter(a => kg.components.find(c => c.id === a.componentId)?.pageId === pageId)
        .map(a => a.componentId));
      const allPageComps = [...pageComps, ...[...explorerInputIds]
        .filter(id => !pageComps.find(c => c.id === id))
        .map(id => graph.nodes.get(id))
        .filter(Boolean)
        .map(n => ({ id: n!.id, role: n!.role || 'spinbutton', name: n!.label, pageId, disabled: false, dynamic: false, selector: n!.selector || '' }))
      ];

      // Categorize components
      const inputs = allPageComps.filter(c => ['spinbutton', 'textbox', 'slider'].includes(c.role));
      const selectors = allPageComps.filter(c => c.role === 'combobox');
      const toggles = allPageComps.filter(c => c.role === 'switch');
      const buttons = allPageComps.filter(c => c.role === 'button');

      // Value-selector buttons (percentage buttons like 10%, 25%, 50%, etc.)
      const valueBtns = buttons.filter(b => /^\d+%$/.test(b.name));

      // Dropdown-like buttons (button that opens a dropdown — check if it has dropdown options)
      const dropdownBtns = buttons.filter(b => {
        const ddOpts = kg.dropdownOptions.filter(d => d.componentId === `comp:${pageId.replace('page:', '')}:combobox:${b.name}`);
        return ddOpts.length > 0;
      });

      // Submit buttons — action-like names
      const submitBtns = buttons.filter(b =>
        /submit|place|trade|send|confirm|enable|stake|deposit|swap|approve|buy|sell|create|save|order/i.test(b.name) &&
        !/info|spread|fee|borrow|calculator|position|trending/i.test(b.name)
      );

      // All form-configuring components
      const configComps = [...inputs, ...toggles, ...valueBtns, ...dropdownBtns];

      // Need at least 2 configurable things and 1 submit to be a form
      if (configComps.length < 2 || submitBtns.length === 0) continue;

      const submitBtn = submitBtns[0];
      const formId = `form:${pageId}`;
      const pageName = kg.pages.find(p => p.id === pageId)?.name || pageId;

      graph.addNode({
        id: formId,
        type: 'form',
        label: `${pageName} form`,
        pageId,
        data: {
          inputCount: inputs.length,
          toggleCount: toggles.length,
          valueBtnCount: valueBtns.length,
          submitButton: submitBtn.name,
        },
      });
      graph.addEdge({ from: pageId, to: formId, type: 'CONTAINS' });

      // Inputs CONFIGURE form
      for (const input of inputs) {
        graph.addEdge({ from: input.id || `comp:${pageId.replace('page:', '')}:${input.role}:${input.name}`, to: formId, type: 'CONFIGURES', label: `${input.role} "${input.name}"` });
      }

      // Value-selector buttons CONFIGURE form
      for (const vb of valueBtns) {
        graph.addEdge({ from: vb.id || `comp:${pageId.replace('page:', '')}:button:${vb.name}`, to: formId, type: 'CONFIGURES', label: `value button "${vb.name}"` });
      }

      // Toggles CONFIGURE form
      for (const toggle of toggles) {
        graph.addEdge({ from: toggle.id || `comp:${pageId.replace('page:', '')}:switch:${toggle.name}`, to: formId, type: 'CONFIGURES', label: `toggle "${toggle.name}"` });
      }

      // Dropdown buttons CONFIGURE form + add HAS_OPTION edges
      for (const db of dropdownBtns) {
        const dbId = db.id || `comp:${pageId.replace('page:', '')}:button:${db.name}`;
        graph.addEdge({ from: dbId, to: formId, type: 'CONFIGURES', label: `dropdown "${db.name}"` });
        const ddKey = `comp:${pageId.replace('page:', '')}:combobox:${db.name}`;
        const ddOptions = kg.dropdownOptions.filter(d => d.componentId === ddKey);
        for (const opt of ddOptions) {
          const optId = `option:${dbId}:${opt.value}`;
          graph.addNode({ id: optId, type: 'component', label: opt.value, role: 'option', pageId, selector: `getByRole('option', { name: '${opt.value}' })` });
          graph.addEdge({ from: dbId, to: optId, type: 'HAS_OPTION' });
        }
      }

      // Also add dropdowns from the KG that weren't matched to buttons
      for (const [, opts] of Object.entries(
        kg.dropdownOptions.reduce((acc, d) => {
          if (!d.componentId.includes(pageId.replace('page:', ''))) return acc;
          if (!acc[d.componentId]) acc[d.componentId] = [];
          acc[d.componentId].push(d);
          return acc;
        }, {} as Record<string, typeof kg.dropdownOptions>)
      )) {
        const parentBtn = buttons.find(b => opts[0]?.componentId.includes(b.name));
        const parentId = parentBtn?.id || opts[0]?.componentId;
        if (parentId && !graph.outEdges.get(parentId)?.some(e => e.type === 'CONFIGURES')) {
          graph.addEdge({ from: parentId, to: formId, type: 'CONFIGURES', label: `dropdown` });
          for (const opt of opts) {
            const optId = `option:${parentId}:${opt.value}`;
            if (!graph.nodes.has(optId)) {
              graph.addNode({ id: optId, type: 'component', label: opt.value, role: 'option', pageId, selector: `getByRole('option', { name: '${opt.value}' })` });
              graph.addEdge({ from: parentId, to: optId, type: 'HAS_OPTION' });
            }
          }
        }
      }

      // Submit button SUBMITS form
      graph.addEdge({ from: submitBtn.id || `comp:${pageId.replace('page:', '')}:button:${submitBtn.name}`, to: formId, type: 'SUBMITS', label: `submit via "${submitBtn.name}"` });

      formCount++;

      console.log(`[KG Builder] Form on ${pageName}: ${inputs.length} inputs, ${toggles.length} toggles, ${valueBtns.length} value buttons, ${dropdownBtns.length} dropdowns → ${submitBtn.name}`);
    }
    console.log(`[KG Builder] ${formCount} form flows detected`);

    // ── D: Build CONSTRAINS edges from docs constraints ──
    let constraintEdgeCount = 0;
    for (const constraint of kg.constraints) {
      const constraintNodeId = `constraint:${constraint.id}`;
      graph.addNode({
        id: constraintNodeId,
        type: 'constraint',
        label: `${constraint.name}: ${constraint.value}`,
        data: constraint,
      });

      // Match constraint to components by keyword
      const keywords = constraint.name.toLowerCase().split(/\s+/);
      for (const comp of kg.components) {
        const compText = `${comp.name} ${comp.role}`.toLowerCase();
        if (keywords.some(kw => compText.includes(kw))) {
          graph.addEdge({ from: constraintNodeId, to: comp.id, type: 'CONSTRAINS' });
          constraintEdgeCount++;
        }
      }

      // Also attach to form nodes
      for (const [nodeId, node] of graph.nodes) {
        if (node.type === 'form') {
          graph.addEdge({ from: constraintNodeId, to: nodeId, type: 'CONSTRAINS' });
          constraintEdgeCount++;
        }
      }
    }
    console.log(`[KG Builder] ${constraintEdgeCount} CONSTRAINS edges`);

    // ── E: Build LEADS_TO chains from explorer flows ──
    let explorerFlowEdges = 0;
    for (const flow of kg.flows) {
      const flowNodeId = `flow:${flow.id}`;
      graph.addNode({
        id: flowNodeId,
        type: 'flow',
        label: flow.name,
        pageId: flow.pageId,
        data: { steps: flow.steps, requiresFundedWallet: flow.requiresFundedWallet, category: flow.category, priority: flow.priority },
      });

      // Connect steps as LEADS_TO chain
      let prevNodeId = flowNodeId;
      for (const step of flow.steps) {
        const stepNodeId = `step:${flow.id}:${step.order}`;
        graph.addNode({
          id: stepNodeId,
          type: 'component',
          label: step.description,
          selector: step.selector,
          pageId: flow.pageId,
        });
        graph.addEdge({ from: prevNodeId, to: stepNodeId, type: 'LEADS_TO' });
        prevNodeId = stepNodeId;
        explorerFlowEdges++;
      }
    }
    console.log(`[KG Builder] ${explorerFlowEdges} LEADS_TO edges from ${kg.flows.length} flows`);

    // ── F: Add edge cases as nodes ──
    for (const ec of kg.edgeCases) {
      graph.addNode({
        id: `edgecase:${ec.id}`,
        type: 'edgeCase',
        label: ec.name,
        data: ec,
      });
      // Try to connect to relevant components
      if (ec.flowId) {
        graph.addEdge({ from: `flow:${ec.flowId}`, to: `edgecase:${ec.id}`, type: 'HAS_EDGE_CASE' });
      }
    }

    // ── G: Add navigation edges between pages ──
    // If shared nav components exist, each page navigates to other pages
    for (let i = 0; i < kg.pages.length; i++) {
      for (let j = 0; j < kg.pages.length; j++) {
        if (i === j) continue;
        graph.addEdge({ from: kg.pages[i].id, to: kg.pages[j].id, type: 'NAVIGATES_TO' });
      }
    }

    // ── H: Add asset nodes ──
    for (const asset of kg.assets) {
      graph.addNode({
        id: asset.id,
        type: 'asset',
        label: asset.symbol,
        data: { group: asset.group, maxLeverage: asset.maxLeverage },
      });
    }

    // ── Summary ──
    const stats = graph.stats;
    console.log(`[KG Builder] Graph: ${stats.nodes} nodes, ${stats.edges} edges`);

    // Compute and log flows
    const allFlows = graph.getAllFlows();
    console.log(`[KG Builder] Computed ${allFlows.length} traversable flows:`);
    for (const flow of allFlows.slice(0, 10)) {
      const permStr = flow.permutations?.length
        ? ` (${flow.permutations.map(p => `${p.field}: ${p.options.length} options`).join(', ')})`
        : '';
      console.log(`  → ${flow.name}${permStr}`);
    }
    if (allFlows.length > 10) console.log(`  ... and ${allFlows.length - 10} more`);

    const unconnected = graph.getUnconnectedComponents();
    if (unconnected.length > 0) {
      console.log(`[KG Builder] ${unconnected.length} components with no edges (explorer should investigate)`);
    }

    // Persist
    const serialized = graph.serialize();
    writeFileSync(join(config.outputDir, 'graph.json'), JSON.stringify(serialized, null, 2));
    writeFileSync(join(config.outputDir, 'computed-flows.json'), JSON.stringify(allFlows, null, 2));

    return {
      graph: serialized,
    };
  };
}

/** Match an appeared element description to an existing component */
function findMatchingComponent(
  components: { id: string; name: string; role: string; pageId: string }[],
  description: string,
  pageId?: string,
): { id: string } | null {
  // Clean up the description (crawler records raw text)
  const clean = description.replace(/^(span|button|dialog|document|h[1-6]|a|div|p):/, '').trim();
  if (!clean || clean.length < 2) return null;

  // Try exact name match on same page
  const exactMatch = components.find(c =>
    c.name === clean && (!pageId || c.pageId === pageId)
  );
  if (exactMatch) return exactMatch;

  // Try partial match
  const partialMatch = components.find(c =>
    c.name && clean.includes(c.name) && (!pageId || c.pageId === pageId)
  );
  if (partialMatch) return partialMatch;

  // Try reverse partial
  const reverseMatch = components.find(c =>
    c.name && c.name.includes(clean) && (!pageId || c.pageId === pageId)
  );
  return reverseMatch || null;
}
