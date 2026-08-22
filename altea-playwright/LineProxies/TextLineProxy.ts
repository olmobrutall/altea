import type { Locator } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/TextLineProxy.cs (TextBase.tsx's three faces) + TextAreaLineProxy.
export abstract class TextBaseLineProxy extends BaseLineProxy {

    get input(): Locator { return this.element.locator(".form-control, .form-control-readonly").first(); }

    override async getValueUntyped(): Promise<unknown> { return await this.getValue(); }
    override async setValueUntyped(value: unknown): Promise<void> { await this.setValue(value as string | null); }

    async setValue(value: string | null): Promise<void> {
        const input = this.input;
        await input.waitFor({ state: "visible" });
        // Playwright best practice (Signum does the same): clear first, then fill.
        await input.fill("");
        if (value != null && value !== "")
            await input.fill(value);
    }

    async getValue(): Promise<string> {
        const input = this.input;
        await input.waitFor({ state: "attached" });
        return await input.inputValue();
    }

    override async isReadonly(): Promise<boolean> {
        const input = this.input;
        await input.waitFor({ state: "attached" });
        return await input.evaluate(e =>
            e.classList.contains("readonly") || e.classList.contains("form-control-plaintext")
            || e.hasAttribute("readonly") || (e as HTMLInputElement).disabled);
    }
}

export class TextBoxLineProxy extends TextBaseLineProxy { }
export class PasswordLineProxy extends TextBaseLineProxy { }
export class ColorLineProxy extends TextBaseLineProxy { }

/** Proxy for TextAreaLine.tsx — the same contract over a `<textarea>`. */
export class TextAreaLineProxy extends TextBaseLineProxy {
    override get input(): Locator { return this.element.locator("textarea, .form-control-readonly").first(); }
}

BaseLineProxy.registerAutoLine((element, route) => {
    const type = route.type;
    if (type == null || type.array || type.lite || type.isEnum || type.getFunction() != null || type.typeName !== "String")
        return null;
    return isMultiLine(route) ? new TextAreaLineProxy(element, route) : new TextBoxLineProxy(element, route);
});

/** Signum keys the textarea on `[StringLengthValidator(MultiLine = true)]`; altea's is the same option. */
function isMultiLine(route: PropertyRoute): boolean {
    const validators = (route.fieldInfo as { validators?: { options?: { multiLine?: boolean } }[] } | undefined)?.validators;
    return validators?.some(v => v.options?.multiLine === true) ?? false;
}
