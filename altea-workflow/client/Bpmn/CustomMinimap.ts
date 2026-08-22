import MMPair from "diagram-js-minimap";

// Port of Signum.Workflow's Bpmn/CustomMinimap.ts — diagram-js-minimap ships its module as a
// `["type", Minimap]` PAIR rather than an exported class, so the class is dug out of the pair and re-wrapped
// under our own module name (which is what lets BpmnModelerComponent list it among its modules). Verbatim.

const Minimap = MMPair.minimap[1] as any;

export class CustomMinimap extends Minimap {
    static $inject: string[] = ["config.minimap", "injector", "eventBus", "canvas", "elementRegistry"];

    constructor(config: any, injector: any, eventBus: any, canvas: any, elementRegistry: any) {
        super(config, injector, eventBus, canvas, elementRegistry);
    }
}

export const __init__: string[] = ["minimap"];
export const minimap: (string | typeof CustomMinimap)[] = ["type", CustomMinimap];
