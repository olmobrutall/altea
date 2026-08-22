import type { Type, Entity } from "../data/entity";
import { TourTriggerSymbol } from "../data/tourTrigger";

// Port of Signum's `TourTriggerLogic` (Signum/Basics/TourTriggerLogic.cs) — the registry of declared tour
// triggers, in the FRAMEWORK for the reason its header gives: a module registers its triggers without
// referencing the optional tour extension, and @altea/altea-tour reads the registry when it starts (an
// application that never starts it simply ignores them).
//
// altea divergence: Signum keys `triggerTypes` by the Type object; here the entity handle is a
// `Type<Entity>` constructor, which is the same thing.
export namespace TourTriggerLogic {

    const tourTriggers = new Set<TourTriggerSymbol>();
    const triggerTypes = new Map<TourTriggerSymbol, Type<Entity>>();

    export function registeredTourTriggers(): TourTriggerSymbol[] {
        return [...tourTriggers];
    }

    /** Signum's `RegisterTourTriggers(params TourTriggerSymbol[])`. */
    export function registerTourTriggers(...triggers: TourTriggerSymbol[]): void {
        for (const t of triggers) {
            if (t == null || t.key == null || t.key === "")
                throw new Error("registerTourTriggers: the trigger has no key (declare it with `init()`)");
            tourTriggers.add(t);
        }
    }

    /**
     * Signum's `RegisterTriggerType`: associate a trigger with an entity type, so the tour editor can offer
     * that type's property routes as "Property" CSS steps — the same thing a `Lite<TypeEntity>` trigger does.
     */
    export function registerTriggerType(trigger: TourTriggerSymbol, type: Type<Entity>): void {
        registerTourTriggers(trigger);
        triggerTypes.set(trigger, type);
    }

    /** Signum's `GetTriggerType`. Keyed by KEY, not identity: a symbol read from the database is a
     *  different instance than the declared singleton (the lesson from the scheduler port). */
    export function getTriggerType(trigger: TourTriggerSymbol): Type<Entity> | undefined {
        for (const [declared, type] of triggerTypes)
            if (declared.key === trigger.key)
                return type;
        return undefined;
    }
}
