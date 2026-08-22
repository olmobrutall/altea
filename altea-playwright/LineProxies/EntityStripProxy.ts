import type { Locator } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy, parseEntityInfo, type EntityInfo } from "./EntityBaseProxy";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityStripProxy.cs (EntityStrip.tsx) — a collection of REFERENCES
// shown as chips, with an autocomplete to add more.
export class EntityStripProxy extends EntityBaseProxy {

    override get itemRoute(): PropertyRoute { return this.route.add("Item"); }

    get strip(): Locator { return this.element.locator("ul.sf-strip").first(); }
    get items(): Locator { return this.strip.locator("[data-entity]"); }
    get autoCompleteElement(): Locator { return this.element.locator(".sf-entity-autocomplete").first(); }

    count(): Promise<number> { return this.items.count(); }

    /** Every chip's `data-entity`, in order. */
    async entityInfos(): Promise<(EntityInfo | null)[]> {
        const values = await this.items.evaluateAll(els => els.map(e => e.getAttribute("data-entity")));
        return values.map(parseEntityInfo);
    }

    /** Signum's `AutoCompleteAsync` — add one by typing. */
    async autoComplete(text: string, resultContainsText = true): Promise<void> {
        await waitChanges(this.element,
            () => this.autoCompleteBasic(this.autoCompleteElement, this.element, text, resultContainsText));
    }

    async autoCompleteLiteValue(lite: Lite<Entity>): Promise<void> {
        await waitChanges(this.element, () => this.autoCompleteLite(this.autoCompleteElement, this.element, lite));
    }

    /** Remove the nth chip. */
    async removeAt(index: number): Promise<void> {
        await waitChanges(this.element, () => this.items.nth(index).locator("a.sf-remove").first().click());
    }

    override async getValueUntyped(): Promise<unknown> { return await this.entityInfos(); }

    override async setValueUntyped(): Promise<void> {
        throw new Error("EntityStripProxy: a collection is edited item by item — use autoComplete() /"
            + " removeAt().");
    }
}

// A COLLECTION of references (not parts): the strip is Signum's fallback for @implementedByAll and for a
// mix of kinds; the repeater / checkbox-list rules are registered later and win when they apply.
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || !type.array || type.isEnum)
        return null;
    return new EntityStripProxy(element, route);
});
