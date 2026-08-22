import type { Locator } from "@playwright/test";
import { waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's Search/QueryTokenBuilderProxy.cs + QueryTokenPartProxy.cs — the chain of
// dropdowns that builds a query token ("Customer.Name", "Entity.CreationDate", …).
//
// altea's tokens are ROOTLESS and camelCase (CLAUDE.md), so a test writes `setToken("customer.name")`, not
// Signum's `"Entity.Customer.Name"` — the DOM contract (`data-full-token` per option) is identical.
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

    /** Open this dropdown (if it is not already) and pick the option whose `data-full-token` is `fullKey`. */
    async select(fullKey: string | null): Promise<void> {
        const popup = this.element.locator(".rw-popup-container");

        if (!await popup.isVisible())
            await this.element.locator(".rw-dropdown-list, .sf-query-token-plus").first().click();

        await waitVisible(popup);

        const tokenSelector = fullKey != null && fullKey !== "" ? `[data-full-token='${fullKey}']` : "";
        const option = popup.locator(`div > span${tokenSelector}`).first();
        await waitVisible(option);
        await option.click();

        // Signum waits for the CHOSEN value to appear in the closed dropdown — that is the "the builder
        // accepted it" signal, and without it the next part can be clicked before this one re-rendered.
        await waitVisible(this.element.locator(`.rw-dropdown-list-value span${tokenSelector}`).first());
    }
}
