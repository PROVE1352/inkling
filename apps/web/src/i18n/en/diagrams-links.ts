// English source strings: Mermaid diagrams in code blocks and [[Page#Heading]] section links
// (docs/adr/2100-*, 2104-*). Keys are 'screen.key' (see i18n/index.ts).
export default {
  // components/blocks/MermaidBlock.tsx
  'mermaid.error': 'Diagram error',
  'mermaid.empty': 'Write Mermaid code here and the diagram appears below',
  'mermaid.loading': 'Drawing the diagram…',
  'mermaid.showCode': 'Show code',
  'mermaid.hideCode': 'Hide code',
  'mermaid.editHint': 'Click to edit the code',
  'mermaid.alt': 'Mermaid diagram',

  // lib/sectionLinks.ts, WikilinkMenu ([[Page#), right panel backlinks
  'sectionLink.notFound': 'Heading "{heading}" was not found on this page',
  'sectionLink.headingIn': 'Heading in {page}',
  'sectionLink.noHeadings': '{page} has no headings',
  'sectionLink.backlinkMissing': '{heading} (not found)',
} satisfies Record<string, string>
