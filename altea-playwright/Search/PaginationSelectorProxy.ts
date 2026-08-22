import type { Locator } from "@playwright/test";
import { waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's Search/PaginationSelectorProxy.cs — the search footer's two selects.
//
// It takes the SearchControl's element (not the proxy) so the two classes do not import each other; the
// caller passes `searchControl.pagination`, which supplies it.
export class PaginationSelectorProxy {

    readonly element: Locator;

    constructor(searchControlElement: Locator) {
        this.element = searchControlElement.locator(".sf-search-footer");
    }

    get elementsPerPageElement(): Locator { return this.element.locator("select.sf-elements-per-page"); }
    get paginationModeElement(): Locator { return this.element.locator("select.sf-pagination-mode"); }

    async setElementsPerPage(elementsPerPage: number): Promise<void> {
        const select = this.elementsPerPageElement;
        await waitVisible(select);
        await select.selectOption(String(elementsPerPage));
    }

    /** "Paginate" / "Firsts" / "All" — the PaginationMode member names. */
    async setPaginationMode(mode: string): Promise<void> {
        const select = this.paginationModeElement;
        await waitVisible(select);
        await select.selectOption(mode);
    }
}
