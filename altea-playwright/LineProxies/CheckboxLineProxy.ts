import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/CheckboxLineProxy.cs (CheckboxLine.tsx).
export class CheckboxLineProxy extends BaseLineProxy {

    get checkbox(): Locator { return this.element.locator("input[type=checkbox]").first(); }

    async setValue(value: boolean): Promise<void> {
        if (value)
            await this.checkbox.check();
        else
            await this.checkbox.uncheck();
    }

    getValue(): Promise<boolean> { return this.checkbox.isChecked(); }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }
    override async setValueUntyped(value: unknown): Promise<void> { await this.setValue(Boolean(value)); }

    override async isReadonly(): Promise<boolean> {
        return await this.checkbox.isDisabled() || (await this.checkbox.getAttribute("readonly")) != null;
    }
}

// A NON-nullable boolean is a checkbox; a nullable one is a three-state EnumLine (Signum's same split).
BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.typeName !== "Boolean" || type.isNullable)
        return null;
    return new CheckboxLineProxy(element, route);
});
