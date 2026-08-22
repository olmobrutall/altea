import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/TimeLineProxy.cs (TimeLine.tsx). altea's value is a
// `Temporal.PlainTime` / `Duration` ISO string — see DateTimeLineProxy for why the proxy speaks strings.
export class TimeLineProxy extends BaseLineProxy {

    get input(): Locator { return this.element.locator("input[type=text]").first(); }

    async setValue(value: string | null): Promise<void> {
        const input = this.input;
        await input.waitFor({ state: "visible" });
        await input.fill("");
        if (value != null && value !== "") {
            await input.fill(value);
            await input.press("Enter");
        }
    }

    async getValue(): Promise<string | null> {
        await this.input.waitFor({ state: "attached" });
        const value = (await this.input.inputValue()).trim();
        return value === "" ? null : value;
    }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setValue(value == null ? null : String(value));
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator("input[readonly]").count() > 0;
    }
}

BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite || type.isEnum || type.getFunction() != null)
        return null;
    return ["PlainTime", "Duration"].includes(type.typeName) ? new TimeLineProxy(element, route) : null;
});
