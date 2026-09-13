import type { Locator } from "playwright";
import { BaseLineProxy } from "./BaseLineProxy";
import { waitVisible } from "../PlaywrightExtensions";
import { editorText, editorValue } from "../tokens";

// Port of Signum.Playwright's LineProxies/EnumLineProxy.cs (EnumLine.tsx): either a plain `<select>` or the
// react-widgets dropdown, depending on how the line was configured — the proxy handles both, as Signum does.
//
// altea divergence: the DOM holds the enum's NUMBER (`value={toStr(oi.value)}`, `data-value={ctx.value}` —
// EnumLine.tsx), where Signum's holds the member name. Either way a test should speak in enum VALUES
// (`OrderState.Shipped`), so this proxy converts both ways through the enum object on the line's own route
// (see tokens.ts' editorText / editorValue) — Signum parses the name into a C# enum for the same reason.
export class EnumLineProxy<S = unknown> extends BaseLineProxy {

    /**
     * The editable `<select>`, or — when the line is READ-ONLY — the input altea renders instead
     * (`FormControlReadonly`: an `<input readonly class="form-control" data-value=…>`, or the plain-text
     * variant). Signum's proxy names only the select, because its readonly rendering keeps the same tag.
     */
    get select(): Locator {
        return this.element.locator("select.form-select, select.form-control,"
            + " input.form-control[data-value], input.form-control-plaintext, .form-control-plaintext").first();
    }

    get widget(): Locator { return this.element.locator("div.rw-dropdown-list").first(); }

    /** The enum value (or its member name — both spellings reach the same option). */
    async setValue(value: S | null): Promise<void> {
        const strValue = value == null ? "" : editorText(value, this.route);

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

    /** The enum VALUE the line holds (its member name when the route names no enum — a nullable boolean). */
    async getValue(): Promise<S | null> {
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

        if (value == null || value === "")
            return null;

        return editorValue(value, this.route) as S;
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value as S | null);
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
