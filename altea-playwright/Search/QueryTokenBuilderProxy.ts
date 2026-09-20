import type { Locator } from "playwright";
import { waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's Search/QueryTokenBuilderProxy.cs + QueryTokenPartProxy.cs — the chain of
// dropdowns that builds a query token ("Customer.Name", "Entity.CreationDate", …).
//
// altea's tokens are ROOTLESS but PascalCase like Signum's (CLAUDE.md), so a test writes
// `setToken("Customer.Name")`, not Signum's rooted `"Entity.Customer.Name"` — the DOM contract
// (`data-full-token` per option) is identical. The match below is on that attribute EXACTLY, so the
// casing is not forgiving here the way the server's token resolution is.
export class QueryTokenBuilderProxy {

    constructor(readonly element: Locator) { }

    /** Signum's `FullKeyAsync` — the token the builder currently holds. */
    fullKey(): Promise<string | null> { return this.element.getAttribute("data-token"); }

    /** The nth dropdown of the chain. */
    part(index: number): QueryTokenPartProxy {
        return new QueryTokenPartProxy(this.element.locator(`.sf-query-token-part:nth-child(${index + 1})`));
    }

    /** Signum's `SelectTokenAsync` — walk the dotted token, picking one part per dropdown. */
    async setToken(token: string): Promise<void> {
        const parts = token.split(".");
        for (let i = 0; i < parts.length; i++)
            await this.part(i).select(parts.slice(0, i + 1).join("."));
    }
}

export class QueryTokenPartProxy {

    constructor(readonly element: Locator) { }

    /**
     * Open this dropdown (if it is not already) and pick the option whose `data-full-token` is `fullKey`.
     *
     * The "add a part" PLUS is checked first and on its own: it and the dropdown are different controls,
     * and clicking whichever the combined selector matched first opened the wrong one. For a real
     * dropdown, "already open" is read from `.rw-open` as well as from the popup's visibility — the popup
     * animates, so between the click and the end of that animation it is neither visibly open nor safe to
     * click again.
     */
    async select(fullKey: string | null): Promise<void> {
        const plus = this.element.locator(".sf-query-token-plus");
        if (await plus.isVisible()) {
            await plus.click();
        } else {
            const alreadyOpen = await this.element.locator(".rw-dropdown-list.rw-open").count() > 0
                || await this.element.locator(".rw-popup-container").isVisible();
            if (!alreadyOpen)
                await this.element.locator(".rw-dropdown-list-value").click();
        }

        const popup = this.element.locator(".rw-popup-container");
        await waitVisible(popup);

        const tokenSelector = fullKey != null && fullKey !== "" ? `[data-full-token='${fullKey}']` : "";
        // The OPTION, not the span inside it: the span is the label, and a click on it during the popup's
        // open animation landed on the row underneath. Forced, because the animation still has the list
        // moving while the option is already hit-testable.
        const option = popup.locator(`.rw-list-option:has(span${tokenSelector})`).first();
        await waitVisible(option);
        await option.click({ force: true });

        // Signum waits for the CHOSEN value to appear in the closed dropdown — that is the "the builder
        // accepted it" signal, and without it the next part can be clicked before this one re-rendered.
        await waitVisible(this.element.locator(`.rw-dropdown-list-value span${tokenSelector}`).first());
    }
}
