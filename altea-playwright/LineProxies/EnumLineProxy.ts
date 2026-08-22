import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";
import { waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EnumLineProxy.cs (EnumLine.tsx): either a plain `<select>` or the
// react-widgets dropdown, depending on how the line was configured — the proxy handles both, as Signum does.
//
// altea divergence: an enum's runtime/wire value is its MEMBER NAME (CLAUDE.md), so this proxy takes and
// returns that string, where Signum parses it back into a C# enum value.
export class EnumLineProxy extends BaseLineProxy {

    get select(): Locator {
        return this.element.locator("select.form-select, select.form-control, .form-control-plaintext").first();
    }

    get widget(): Locator { return this.element.locator("div.rw-dropdown-list").first(); }

    async setValue(value: string | null): Promise<void> {
        const strValue = value ?? "";

        if (await this.widget.count() > 0) {
            const popup = this.widget.locator(".rw-popup-container");
            if (!await popup.isVisible()) {
                await this.widget.locator(".rw-dropdown-list-value").click();
                await waitVisible(popup);
            }
            await popup.locator(`[data-value='${strValue}']`).click();
            return;
        }

        await this.select.selectOption(strValue);
    }

    async getValue(): Promise<string | null> {
        let value: string | null;

        if (await this.widget.count() > 0) {
            value = await this.widget.locator("[data-value]").first().getAttribute("data-value");
        } else {
            const element = this.select;
            const isSelect = await element.evaluate(e => e.tagName.toLowerCase() === "select");
            value = isSelect
                ? await element.evaluate(e => (e as HTMLSelectElement).value)
                : await element.getAttribute("data-value");
        }

        return value == null || value === "" ? null : value;
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value == null ? null : String(value));
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator("input[readonly]").count() > 0;
    }
}

// An enum field — or a NULLABLE boolean, which altea renders as a three-state EnumLine (Signum's rule too).
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite)
        return null;
    if (type.isEnum || (type.typeName === "Boolean" && type.isNullable))
        return new EnumLineProxy(element, route);
    return null;
});
