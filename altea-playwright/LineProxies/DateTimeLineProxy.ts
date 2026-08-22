import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/DateTimeLineProxy.cs (DateTimeLine.tsx, a react-widgets picker).
//
// altea divergence: the value is a `Temporal` ISO string (`2026-08-22`, `2026-08-22T10:30`), not a .NET
// DateTime — so this proxy takes and returns the STRING the input holds, which is also what a test asserting
// a stored PlainDate wants.
export class DateTimeLineProxy extends BaseLineProxy {

    /** The editable input inside the picker; `sf-readonly-date` is the read-only rendering. */
    get input(): Locator {
        return this.element
            .locator("div.rw-date-picker input[type=text], input.sf-readonly-date, div.sf-readonly-date")
            .first();
    }

    async setValue(value: string | null): Promise<void> {
        const input = this.input;
        await input.waitFor({ state: "visible" });
        await input.fill("");
        if (value != null && value !== "") {
            await input.fill(value);
            // react-widgets parses on blur / Enter; Signum presses Enter for the same reason.
            await input.press("Enter");
        }
    }

    async getValue(): Promise<string | null> {
        const input = this.input;
        await input.waitFor({ state: "attached" });
        const text = await input.evaluate(e =>
            e.tagName.toLowerCase() === "input" ? (e as HTMLInputElement).value : e.textContent ?? "");
        return text.trim() === "" ? null : text.trim();
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value == null ? null : String(value));
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator("input.sf-readonly-date, div.sf-readonly-date").count() > 0;
    }
}

BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite || type.isEnum || type.getFunction() != null)
        return null;
    return ["PlainDate", "PlainDateTime", "ZonedDateTime"].includes(type.typeName)
        ? new DateTimeLineProxy(element, route)
        : null;
});
