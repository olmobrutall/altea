import type { Locator } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy } from "./EntityBaseProxy";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityListCheckBoxProxy.cs (EntityCheckboxList.tsx) — a
// low-population collection as a list of checkboxes. altea's element class is `sf-checkbox-element`, the
// same as Signum's.
export class EntityCheckboxListProxy extends EntityBaseProxy {

    override get itemRoute(): PropertyRoute { return this.route.add("Item"); }

    get elements(): Locator { return this.element.locator(".sf-checkbox-element"); }

    /** The checkbox whose label reads `label`. */
    checkboxByLabel(label: string): Locator {
        return this.elements.filter({ hasText: label }).locator("input[type=checkbox]").first();
    }

    async setChecked(label: string, checked: boolean): Promise<void> {
        await waitChanges(this.element, async () => {
            const box = this.checkboxByLabel(label);
            if (checked)
                await box.check();
            else
                await box.uncheck();
        });
    }

    /** Every checked element's label. */
    async checkedLabels(): Promise<string[]> {
        const labels = await this.elements.evaluateAll(els => els
            .filter(e => (e.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.checked)
            .map(e => (e.textContent ?? "").trim()));
        return labels;
    }

    override async getValueUntyped(): Promise<unknown> { return await this.checkedLabels(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        const wanted = new Set((value as string[] | null ?? []).map(String));
        const all = await this.elements.evaluateAll(els => els.map(e => (e.textContent ?? "").trim()));
        for (const label of all)
            await this.setChecked(label, wanted.has(label));
    }
}

// A COLLECTION whose every implementation is low-population (Signum's IsLowPopulation rule).
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || !type.array || type.isEnum || type.isByAll())
        return null;
    const infos = type.typeInfos();
    if (infos.length === 0 || !infos.every(ti => ti.lowPopulation === true))
        return null;
    return new EntityCheckboxListProxy(element, route);
});
