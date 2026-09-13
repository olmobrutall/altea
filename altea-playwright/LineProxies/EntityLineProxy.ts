import type { Locator } from "playwright";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy, type EntityOf } from "./EntityBaseProxy";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityLineProxy.cs (EntityLine.tsx).
export class EntityLineProxy<S = unknown> extends EntityBaseProxy<S> {

    get autoCompleteElement(): Locator { return this.element.locator(".sf-entity-autocomplete").first(); }

    /** Signum's `GetLiteAsync` — what the line currently holds. */
    getValue(): Promise<Lite<EntityOf<S> & Entity> | null> { return this.getLite(); }

    /** Signum's `AutoCompleteAsync(beginning)` — type and pick the first match. */
    async autoComplete(text: string, resultContainsText = true): Promise<void> {
        await waitChanges(this.element,
            () => this.autoCompleteBasic(this.autoCompleteElement, this.element, text, resultContainsText));
    }

    /** Signum's `AutoCompleteAsync(lite)` — type and pick THAT entity. */
    async autoCompleteLiteValue(lite: Lite<EntityOf<S> & Entity>): Promise<void> {
        await waitChanges(this.element, () => this.autoCompleteLite(this.autoCompleteElement, this.element, lite));
    }

    /**
     * Signum's `SetLiteAsync`: clear what is there, then set the new value — through the autocomplete when
     * the line has one, else through the find modal.
     */
    async setValue(value: Lite<EntityOf<S> & Entity> | (EntityOf<S> & Entity) | null): Promise<void> {
        const lite = value == null ? null : value instanceof Entity ? value.toLite() as Lite<EntityOf<S> & Entity> : value;
        if (await this.entityInfo() != null)
            await this.remove();

        if (lite == null)
            return;

        if (await this.autoCompleteElement.isVisible()) {
            await this.autoCompleteLiteValue(lite);
            return;
        }

        throw new Error("EntityLineProxy.setValue: the line has no autocomplete; open findModal() and pick"
            + " the row through SearchModalProxy instead.");
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getLite(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value as Lite<EntityOf<S> & Entity> | null);
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator(".form-control[readonly]").count() > 0
            && await this.element.locator("a.sf-create, a.sf-find, a.sf-remove").count() === 0;
    }
}

// A single (non-collection) ENTITY / Lite reference. altea picks EntityCombo for a low-population type and
// EntityDetail for a Part, exactly as Signum's dispatcher does — those rules are registered in their own
// modules and run BEFORE this one (later registrations win), so this is the fallback.
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.isEnum)
        return null;
    // An ENTITY reference (a Lite, an @implementedBy, or a bare entity class). The embedded / low-population
    // / part rules live in their own modules and are registered later, so they win over this fallback.
    const isEntity = type.lite === true || type.isByAll()
        || type.typeInfos().some(ti => ti.kind === "Entity");
    return isEntity ? new EntityLineProxy(element, route) : null;
});
