// Hand-written typings for bpmn-js 7.5.0 + diagram-js-minimap 2.0.4 — a near-verbatim port of Signum's
// Signum.Workflow/bpmn-js.ts.
//
// The VERSION is pinned to Signum's on purpose (the same call altea-html-editor makes about Lexical): the
// custom renderer, context pad and popup menu below extend bpmn-js INTERNALS, and those internals were
// rewritten between v7 and today's v18 (the popup-menu API in particular). Following Signum's pin keeps this
// port comparable and mechanical; a bpmn-js major upgrade is a separate project.
//
// bpmn-js ships no types of its own at this version, and only the slice the designer touches is declared.
// The `BPMN` namespace is GLOBAL (as in Signum) so the five module-extension files read like the originals.

declare namespace BPMN {

    type ElementType =
        "bpmn:Participant" |
        "bpmn:Lane" |

        "bpmn:StartEvent" |
        "bpmn:EndEvent" |

        "bpmn:IntermediateThrowEvent" |
        "bpmn:BoundaryEvent" |
        "bpmn:IntermediateCatchEvent" |

        "bpmn:Task" |
        "bpmn:UserTask" |
        "bpmn:CallActivity" |
        "bpmn:ScriptTask" |

        "bpmn:ExclusiveGateway" |
        "bpmn:InclusiveGateway" |
        "bpmn:ParallelGateway" |

        "bpmn:SequenceFlow" |
        "bpmn:MessageFlow" |

        "label" |
        "bpmn:TextAnnotation" |
        "bpmn:DataObjectReference" |
        "bpmn:DataStoreReference";

    type EventDefinitionType =
        "bpmn:TimerEventDefinition" |
        "bpmn:ConditionalEventDefinition";

    interface Options {
        container?: HTMLElement;
        width?: number | string;
        height?: number | string;
        moddleExtensions?: any;
        modules?: any[];
        additionalModules?: any[];
        keyboard?: {
            bindTo?: Node;
        };
    }

    interface SaveOptions {
        format?: boolean;
        preamble?: boolean;
    }

    interface Definitions {
    }

    interface Event {
        type: string;
    }

    interface DoubleClickEvent extends Event {
        element: DiElement;
        gfx: SVGElement;
        originalEvent: MouseEvent;

        stopPropagation(): void;
        preventDefault(): void;
    }

    interface ElementEvent extends Event {
        element: DiElement;
    }

    interface PasteEvent extends Event {
        createdElements: { [oldId: string]: CreatedElement };
        descriptor: Descriptor;
    }

    interface DeletePostExecutedEvent extends Event {
        command: string;
        context: { elements: DiElement[] };
    }

    interface CanMoveElementEvent extends Event {
        command: string;
        context: { shapes: DiElement[] };
    }

    interface CreatedElement {
        descriptor: Descriptor;
        element: DiElement;
    }

    interface Descriptor {
        id: string;
        name: string;
        type: string;
    }

    interface EndedEvent extends Event {
        context: {
            shape: DiElement;
            target: DiElement;
        };
    }

    interface AutoPlaceEndEvent extends Event {
        shape: DiElement;
    }

    interface DiElement {
        attachers: any[];
        businessObject: ModdleElement;
        type: ElementType;
        id: string;
        host: DiElement;
        parent: DiElement;
        label: DiElement;
        colapsed: boolean;
        hidden: boolean;
        width: number;
        height: number;
        x: number;
        y: number;
        incoming: Connection[];
        outgoing: Connection[];
    }

    interface Connection extends DiElement {
        waypoints: DiElement[];
    }

    interface ModdleElement {
        id: string;
        parent: ModdleElement;
        di: DiElement;
        name: string;
        $type: ElementType;
        bounds: BoundsElement;
        lanes: ModdleElement[];
        eventDefinitions?: ModdleElement[];
        incoming?: ConnectionModdleElemnet[];
        outgoing?: ConnectionModdleElemnet[];
    }

    interface BoundsElement extends ModdleElement {
        height: number;
        width: number;
        x: number;
        y: number;
    }

    interface ConnectionModdleElemnet extends ModdleElement {
        sourceRef: ModdleElement;
        targetRef: ModdleElement;
    }

    interface ElementRegistry {
        get(elementId: string): BPMN.DiElement;
        getAll(): BPMN.DiElement[];
        getGraphics(element: BPMN.DiElement): SVGElement;
        forEach(action: (element: BPMN.DiElement) => void): void;
    }

    interface GraphicsFactory {
        update(type: string, element: BPMN.DiElement, gfx: SVGElement): void;
    }

    interface BpmnFactory {
        create(type: string, attrs: any): ModdleElement;
    }

    interface BpmnReplace {
        replaceElement(element: BPMN.DiElement, target: BpmnReplaceTarget, hints?: any): BPMN.DiElement;
    }

    interface BpmnReplaceTarget {
        type: ElementType;
        eventDefinitionType: EventDefinitionType;
    }

    interface EventBus {
        on(event: string, callback: (obj: BPMN.Event) => void, target?: BPMN.DiElement): void;
        on(event: string, priority: number, callback: (obj: BPMN.Event) => void, target?: BPMN.DiElement): void;
        off(event: string, callback: () => void): void;
    }

    interface Overlays {
        add(element: BPMN.DiElement, type: string, overlay: Overlay): void;
        remove(condition: { type: string }): void;
    }

    interface Overlay {
        position: RelativePosition;
        html: string;
    }

    interface RelativePosition {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    }

    interface MenuEntry {
        label: string;
        className: string;
        action: () => void;
    }

    type EntriesObject = { [key: string]: BPMN.MenuEntry };
}

declare module "bpmn-js/lib/Viewer" {

    export default class Viewer {
        _modules: any[];
        constructor(options: BPMN.Options);
        importXML(xml: string, done: (error: string, warning: string[]) => void): void;
        saveXML(options: BPMN.SaveOptions, done: (error: string, xml: string) => void): void;
        saveSVG(options: BPMN.SaveOptions, done: (error: string, svgStr: string) => void): void;
        importDefinitions(definition: BPMN.Definitions, done: (error: string) => void): void;
        getModules(): void;
        destroy(): void;
        on(event: string, callback: (obj: BPMN.Event) => void, target?: BPMN.DiElement): void;
        on(event: string, priority: number, callback: (obj: BPMN.Event) => void, target?: BPMN.DiElement): void;
        off(event: string, callback: () => void): void;
        get<T>(module: string): T;
        _emit(event: string, element: object): void;
    }
}

declare module "bpmn-js/lib/NavigatedViewer" {

    import Viewer from "bpmn-js/lib/Viewer";

    export default class NavigatedViewer extends Viewer {
    }
}

declare module "bpmn-js/lib/Modeler" {
    import Viewer from "bpmn-js/lib/Viewer";

    export default class Modeler extends Viewer {
        createDiagram(done: (error: string, warning: string[]) => void): void;
    }
}

declare module "bpmn-js/lib/draw/BpmnRenderer" {

    export default class BpmnRenderer {
        constructor(config: any, eventBus: BPMN.EventBus, styles: any, pathMap: any, canvas: any, textRenderer: any, priority: number);

        drawShape(visuals: any, element: BPMN.DiElement): SVGElement;
        drawConnection(visuals: any, element: BPMN.Connection): SVGElement;
    }
}

declare module "bpmn-js/lib/features/popup-menu/ReplaceMenuProvider" {

    export default class BpmnReplaceMenuProvider {
        constructor(popupMenu: any, modeling: any, moddle: BPMN.ModdleElement, bpmnReplace: any, rules: any, translate: any);

        getEntries(element: BPMN.DiElement): BPMN.MenuEntry[];
        getHeaderEntries(element: BPMN.DiElement): BPMN.MenuEntry[];
        getPopupMenuEntries(element: BPMN.DiElement): ((entries: BPMN.EntriesObject) => BPMN.EntriesObject);
    }
}

declare module "bpmn-js/lib/features/context-pad/ContextPadProvider" {

    export default class BpmnContextPadProvider {
        constructor(config: any, injector: any, eventBus: any, contextPad: any, modeling: any, elementFactory: any, connect: any, create: any, popupMenu: any, canvas: any, rules: any, translate: any);

        getContextPadEntries(element: BPMN.DiElement): any;
    }
}

declare module "bpmn-js/lib/features/search" {
    const a: {};
    export default a;
}

declare module "diagram-js-minimap" {

    class Minimap {
        constructor(config: any, injector: any, eventBus: any, canvas: any, elementRegistry: any);
    }

    const pair: {
        "minimap": ["type", typeof Minimap];
        "__init__": ["minimap"];
    };

    export default pair;
}

// The bundled stylesheets the designer imports for its side effect.
declare module "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";
declare module "diagram-js/assets/diagram-js.css";
declare module "diagram-js-minimap/assets/diagram-js-minimap.css";
