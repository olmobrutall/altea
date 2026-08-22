import BpmnReplaceMenuProvider from "bpmn-js/lib/features/popup-menu/ReplaceMenuProvider";
import * as BpmnUtils from "./BpmnUtils";

// Port of Signum.Workflow's Bpmn/CustomPopupMenu.ts — bpmn-js offers to replace a shape with any of dozens of
// BPMN element kinds; a workflow supports far fewer, so the menu is pruned to the ones that mean something
// here (three gateway kinds, the timer intermediate catch, the two timer boundaries) and emptied elsewhere.
// Verbatim except for the imports.

export class CustomReplaceMenuProvider extends BpmnReplaceMenuProvider {
    static $inject: string[] = ["popupMenu", "modeling", "moddle", "bpmnReplace", "rules", "translate"];

    constructor(popupMenu: any, modeling: any, moddle: BPMN.ModdleElement, bpmnReplace: any, rules: any, translate: any) {
        super(popupMenu, modeling, moddle, bpmnReplace, rules, translate);
    }

    override getHeaderEntries(_element: BPMN.DiElement): never[] {
        return [];
    }

    override getPopupMenuEntries(element: BPMN.DiElement): (entries: BPMN.EntriesObject) => BPMN.EntriesObject {

        if (BpmnUtils.isGatewayAnyKind(element.type))
            return this.entriesOrUpdaterGateways;

        if (element.type === "bpmn:IntermediateThrowEvent")
            return this.entriesOrUpdaterIntermediateEvents;

        if (element.type === "bpmn:BoundaryEvent")
            return this.entriesOrUpdaterBoundaryEvents;

        return this.entriesOrUpdaterEmpty;
    }

    entriesOrUpdaterGateways(entries: BPMN.EntriesObject): BPMN.EntriesObject {
        Object.keys(entries)
            .filter(key => key !== "replace-with-parallel-gateway"
                && key !== "replace-with-inclusive-gateway"
                && key !== "replace-with-exclusive-gateway")
            .forEach(key => delete entries[key]);

        return entries;
    }

    entriesOrUpdaterIntermediateEvents(entries: BPMN.EntriesObject): BPMN.EntriesObject {
        Object.keys(entries)
            .filter(key => key !== "replace-with-timer-intermediate-catch")
            .forEach(key => delete entries[key]);

        return entries;
    }

    entriesOrUpdaterBoundaryEvents(entries: BPMN.EntriesObject): BPMN.EntriesObject {
        Object.keys(entries)
            .filter(key => key !== "replace-with-timer-boundary"
                && key !== "replace-with-non-interrupting-timer-boundary")
            .forEach(key => delete entries[key]);

        return entries;
    }

    entriesOrUpdaterEmpty(entries: BPMN.EntriesObject): BPMN.EntriesObject {
        Object.keys(entries).forEach(key => delete entries[key]);
        return entries;
    }
}

export const __init__: string[] = ["customReplaceMenuProvider"];
export const customReplaceMenuProvider: (string | typeof CustomReplaceMenuProvider)[] = ["type", CustomReplaceMenuProvider];
