import type { Page } from "@playwright/test";
import type { Entity, EntityType } from "@altea/altea/data/entity";
import type { FrameModalProxy } from "../Frames/FrameModalProxy";
import { waitVisible, type AsyncScoped } from "../PlaywrightExtensions";
import { SearchControlProxy } from "./SearchControlProxy";
import { ResultTableProxy } from "./ResultTableProxy";
import { FiltersProxy } from "./FiltersProxy";
import { PaginationSelectorProxy } from "./PaginationSelectorProxy";

// Port of Signum.Playwright's Search/SearchPageProxy.cs — a whole `/find/<Query>` page.
export class SearchPageProxy implements AsyncScoped {

    /** A search page is a SCOPE (see PlaywrightExtensions' AsyncScoped) so it chains with `scoped(...)` the
     *  way Signum's `b.SearchPageAsync(...).Then(async persons => …)` does. Nothing to close. */
    async [Symbol.asyncDispose](): Promise<void> { }


    private constructor(readonly page: Page, readonly searchControl: SearchControlProxy) { }

    /** Signum's `SearchPageProxy.NewAsync(page)`. */
    static async create(page: Page, queryKey: string, waitInitialSearch = true): Promise<SearchPageProxy> {
        const element = page.locator(".sf-search-page .sf-search-control").first();
        await waitVisible(element);

        const proxy = new SearchPageProxy(page, new SearchControlProxy(element, queryKey));
        if (waitInitialSearch)
            await proxy.searchControl.waitInitialSearchCompleted();
        return proxy;
    }

    get results(): ResultTableProxy { return this.searchControl.results; }
    get filters(): FiltersProxy { return this.searchControl.filters; }
    get pagination(): PaginationSelectorProxy { return this.searchControl.pagination; }

    search(): Promise<void> { return this.searchControl.search(); }

    /** Signum's `CreateAsync<T>` — the page's Create button, which opens a modal SCOPE. */
    createModal<T extends Entity>(rootType: EntityType<T>): Promise<FrameModalProxy<T>> {
        return this.searchControl.createModal<T>(rootType);
    }
}
