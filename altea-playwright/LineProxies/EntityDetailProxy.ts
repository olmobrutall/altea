import type { Locator } from "@playwright/test";
import { PropertyRouteType } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy, type EntityInfo } from "./EntityBaseProxy";
import { LineContainer } from "../Frames/LineContainer";

// Port of Signum.Playwright's LineProxies/EntityDetailProxy.cs (EntityDetail.tsx) — a single value edited
// IN PLACE, inside a fieldset whose `<legend>` carries the buttons.
export class EntityDetailProxy extends EntityBaseProxy {

    /** Signum: the buttons of a detail live in its legend, not in the body. */
    override get buttonBar(): Locator { return this.element.locator("> legend, legend").first(); }

    /** Signum's `Details<T>()` — the lines INSIDE the detail, as their own container. */
    details<T extends BaseEntity>(): LineContainer<T> {
        const subRoute = this.route.propertyRouteType === PropertyRouteType.LiteEntity
            ? this.route
            : this.route.add("Entity").propertyRouteType === PropertyRouteType.LiteEntity
                ? this.route.add("Entity")
                : this.route;

        return new LineContainer<T>(this.element, subRoute);
    }

    /** Signum's `GetOrCreateDetailControlAsync<T>` — create the value first when the detail is empty. */
    async getOrCreateDetails<T extends BaseEntity>(): Promise<LineContainer<T>> {
        if (await this.entityInfo() == null)
            await this.createEmbedded();
        return this.details<T>();
    }

    getEntityInfo(): Promise<EntityInfo | null> { return this.entityInfo(); }

    override async getValueUntyped(): Promise<unknown> { return await this.entityInfo(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        if (value == null) {
            if (await this.entityInfo() != null)
                await this.remove();
            return;
        }
        throw new Error("EntityDetailProxy.setValueUntyped: a detail is edited in place — use"
            + " getOrCreateDetails() and set its lines.");
    }

    override async isReadonly(): Promise<boolean> {
        return await this.buttonBar.locator("a.sf-create, a.sf-find, a.sf-remove").count() === 0;
    }
}

// An EMBEDDED value (no Lite, a class that is not a persisted entity) renders as a detail — Signum's rule.
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite || type.isEnum)
        return null;
    const infos = type.typeInfos();
    if (infos.length !== 1 || infos[0]!.kind !== "Model")
        return null;
    return new EntityDetailProxy(element, route);
});
