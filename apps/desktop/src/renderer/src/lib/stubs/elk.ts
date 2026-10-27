// elkjs (EPL-2.0) n'est pas embarqué : la disposition « elk » de Mermaid est indisponible,
// les diagrammes utilisent la disposition standard (dagre). Un diagramme qui exige elk échoue
// proprement et reste affiché comme code.
export default class ElkUnavailable {
  constructor() {
    throw new Error('Disposition Mermaid « elk » indisponible dans Monolith Harness.');
  }
}
