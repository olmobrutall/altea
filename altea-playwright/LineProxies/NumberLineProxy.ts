import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/NumberLineProxy.cs (NumberLine.tsx — the `.numeric` input).
export class NumberLineProxy extends BaseLineProxy {

    get input(): Locator { return this.element.locator("input.numeric").first(); }
    get readonlyInput(): Locator { return this.element.locator("input.numeric[readonly], div.readonly.numeric").first(); }
    get anyInput(): Locator { return this.element.locator("input.numeric, div.readonly.numeric").first(); }

    async setValue(value: number | null, loseFocus = false): Promise<void> {
        const input = this.input;
        await input.waitFor({ state: "visible" });
        await input.fill(value == null ? "" : String(value));
        // Signum's `loseFocus`: a NumberLine formats and commits on BLUR, so a test that reads the value
        // straight back (or asserts a dependent line) has to leave the field first.
        if (loseFocus)
            await input.blur();
    }

    async getValue(): Promise<number | null> {
        const input = this.anyInput;
        await input.waitFor({ state: "attached" });
        const text = await input.evaluate(e =>
            e.tagName.toLowerCase() === "input" ? (e as HTMLInputElement).value : e.textContent ?? "");
        const clean = text.trim();
        return clean === "" ? null : Number(clean.replace(/[^\d.,-]/g, "").replace(",", "."));
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value == null ? null : Number(value));
    }

    override async isReadonly(): Promise<boolean> { return await this.readonlyInput.count() > 0; }
}

BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite || type.isEnum || type.getFunction() != null)
        return null;
    return ["Number", "Decimal"].includes(type.typeName) ? new NumberLineProxy(element, route) : null;
});
