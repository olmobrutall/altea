import type { Locator } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy } from "./EntityBaseProxy";
import { LineContainer } from "../Frames/LineContainer";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityRepeaterProxy.cs (EntityRepeater.tsx) — a collection edited
// as a stack of fieldsets, one per element.
//
// NOTE the class name: altea keeps Signum's `sf-repater-elements` TYPO on the container (both frameworks
// have it), so the selector is spelled the same way here on purpose.
export class EntityRepeaterProxy<S extends BaseEntity = BaseEntity> extends EntityBaseProxy<S> {

    /** The route of ONE element (Signum's ItemRoute): the collection route + "Item". */
    override get itemRoute(): PropertyRoute { return this.route.add("Item"); }

    get elementsContainer(): Locator { return this.element.locator(".sf-repater-elements").first(); }

    get elements(): Locator { return this.element.locator("fieldset.sf-repeater-element"); }

    /** How many rows the repeater currently shows. */
    count(): Promise<number> { return this.elements.count(); }

    /** Signum's `ElementLineContainer<T>(index)` — the lines of ONE element. */
    elementAt(index: number): LineContainer<S> {
        return new LineContainer<S>(this.elements.nth(index), this.itemRoute);
    }

    /** Signum's `CreateElementAsync<T>` — add a row and return its lines. */
    async createElement(): Promise<LineContainer<S>> {
        const before = await this.count();
        await waitChanges(this.element, () => this.createButton.click());
        return this.elementAt(before);
    }

    /** Remove ONE element (its own remove button, not the line's). */
    async removeElement(index: number): Promise<void> {
        await waitChanges(this.element, () => this.elements.nth(index).locator("a.sf-remove").first().click());
    }

    override async getValueUntyped(): Promise<unknown> { return await this.count(); }

    override async setValueUntyped(): Promise<void> {
        throw new Error("EntityRepeaterProxy: a collection is edited element by element — use"
            + " createElement() / removeElement() / elementAt().");
    }
}

// A COLLECTION of @part rows / embeddeds renders as a repeater (Signum: every implementation is a Part).
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || !type.array)
        return null;
    const infos = type.typeInfos();
    if (infos.length === 0 || !infos.every(ti => ti.entityKind === "Part" || ti.entityKind === "SharedPart"))
        return null;
    return new EntityRepeaterProxy(element, route);
});
