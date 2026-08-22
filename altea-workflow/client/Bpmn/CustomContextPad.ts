import BpmnContextPadProvider from "bpmn-js/lib/features/context-pad/ContextPadProvider";

// Port of Signum.Workflow's Bpmn/CustomContextPad.ts — drop the context-pad buttons a workflow has no use
// for: text annotations, and (on a pool / lane) the lane-splitting and pool-connecting tools. Verbatim.

export class CustomContextPadProvider extends BpmnContextPadProvider {
    static $inject: string[] = ["config.contextPad", "injector", "eventBus", "contextPad", "modeling",
        "elementFactory", "connect", "create", "popupMenu", "canvas", "rules", "translate"];

    constructor(config: any, injector: any, eventBus: any, contextPad: any, modeling: any, elementFactory: any,
        connect: any, create: any, popupMenu: any, canvas: any, rules: any, translate: any) {
        super(config, injector, eventBus, contextPad, modeling, elementFactory, connect, create, popupMenu,
            canvas, rules, translate);
    }

    override getContextPadEntries(element: BPMN.DiElement): any {
        const result = super.getContextPadEntries(element);

        delete result["append.text-annotation"];

        if (element.type === "bpmn:Lane" || element.type === "bpmn:Participant") {
            delete result["lane-divide-two"];
            delete result["lane-divide-three"];

            if (element.type === "bpmn:Participant")
                delete result["connect"];
        }

        return result;
    }
}

export const __init__: string[] = ["contextPadProvider"];
export const contextPadProvider: (string | typeof CustomContextPadProvider)[] = ["type", CustomContextPadProvider];
