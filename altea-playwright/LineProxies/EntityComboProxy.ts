import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy, type EntityInfo } from "./EntityBaseProxy";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityComboProxy.cs (EntityCombo.tsx) — the `<select>` a
// low-population type gets, or the react-widgets list when the combo was configured with one.
export class EntityComboProxy extends EntityBaseProxy {

    get combo(): Locator { return this.element.locator("select").first(); }
    get dropdownListInput(): Locator { return this.element.locator(".rw-dropdown-list-input").first(); }

    /** Signum's `GetLiteValueAsync` — the selected option's `data-entity`. */
    async getSelected(): Promise<EntityInfo | null> {
        const selected = this.combo.locator("option:checked");
        if (await selected.count() === 0)
            return null;
        return await this.entityInfo();
    }

    /** Signum's `SelectLabelAsync` — pick by the text the user sees. */
    async selectLabel(label: string): Promise<void> {
        await waitChanges(this.element, () => this.combo.selectOption({ label }).then(() => undefined));
    }

    /** Signum's `SelectIndexAsync` — pick the nth option (0 is the empty one when the line is nullable). */
    async selectIndex(index: number): Promise<void> {
        await waitChanges(this.element, () => this.combo.selectOption({ index }).then(() => undefined));
    }

    /** Signum's `OptionsAsync` — every option's label, in order. */
    async options(): Promise<string[]> {
        return await this.combo.locator("option").allTextContents();
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getSelected(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        if (value == null) {
            await this.selectIndex(0);
            return;
        }
        await this.selectLabel(String(value));
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator("input[readonly]").count() > 0 || await this.combo.isDisabled();
    }
}

// altea renders an EntityCombo for a LOW-POPULATION type (`@entity(kind, data, { lowPopulation: true })`),
// which is exactly Signum's `EntityKindCache.IsLowPopulation` rule.
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.isEnum || type.isByAll())
        return null;
    const infos = type.typeInfos();
    if (infos.length === 0 || !infos.every(ti => ti.lowPopulation === true))
        return null;
    return new EntityComboProxy(element, route);
});
