import type { Locator } from "playwright";
import { BaseLineProxy } from "./BaseLineProxy";
import type { NumberMember } from "../Frames/LineContainer";

// Port of Signum.Playwright's LineProxies/NumberLineProxy.cs (NumberLine.tsx — the `.numeric` input).
export class NumberLineProxy<S extends NumberMember = NumberMember> extends BaseLineProxy {

    get input(): Locator { return this.element.locator("input.numeric").first(); }
    get readonlyInput(): Locator { return this.element.locator("input.numeric[readonly], div.readonly.numeric").first(); }
    get anyInput(): Locator { return this.element.locator("input.numeric, div.readonly.numeric").first(); }

    /** The member's own value — a number, or a `Decimal` for a decimal column. */
    async setValue(value: S | number | null, loseFocus = false): Promise<void> {
        const input = this.input;
        await input.waitFor({ state: "visible" });
        await input.fill(value == null ? "" : String(value));
        // Signum's `loseFocus`: a NumberLine formats and commits on BLUR, so a test that reads the value
        // straight back (or asserts a dependent line) has to leave the field first.
        if (loseFocus)
            await input.blur();
    }

    /**
     * The member's value as a number.
     *
     * A READ-ONLY number is rendered FORMATTED — grouped, and for a percentage column multiplied by a
     * hundred and suffixed — so it cannot be parsed as a bare numeral. Signum reads the separators off the
     * test process's CurrentCulture; there is no such thing here, so the parse happens in the PAGE, where
     * `document.documentElement.lang` says which culture rendered the text and Intl gives that culture's
     * own separators. The editable input is unformatted and falls through the same code unchanged.
     */
    async getValue(): Promise<number | null> {
        const input = this.anyInput;
        await input.waitFor({ state: "attached" });
        return await input.evaluate(e => {
            const raw = (e.tagName.toLowerCase() === "input" ? (e as HTMLInputElement).value : e.textContent ?? "").trim();
            if (raw === "")
                return null;

            const locale = document.documentElement.lang || undefined;
            const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
            const group = parts.find(p => p.type === "group")?.value ?? ",";
            const decimal = parts.find(p => p.type === "decimal")?.value ?? ".";
            // The percent sign arrives with its own spacing in several cultures, including a non-breaking
            // one, so it is matched as a character rather than trimmed around.
            const percent = /[%\u2030]/.test(raw);

            let s = raw;
            for (const sep of new Set([group, "\u00A0", "\u202F", "\u2009", " "]))
                s = s.split(sep).join("");
            s = s.split(decimal).join(".").replace(/[^\d.eE+-]/g, "");

            const n = Number(s);
            if (Number.isNaN(n))
                return null;
            return percent ? n / 100 : n;
        });
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
