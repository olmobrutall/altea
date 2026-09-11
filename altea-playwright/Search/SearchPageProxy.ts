import type { Page } from "@playwright/test";
import type { BaseEntity, Entity, Type } from "@altea/altea/data/entity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { FrameModalProxy } from "../Frames/FrameModalProxy";
import { scope, waitVisible, type AsyncScoped, type Scope } from "../PlaywrightExtensions";
import { tokenString, type TokenOf } from "../tokens";
import { SearchControlProxy } from "./SearchControlProxy";
import { ResultTableProxy } from "./ResultTableProxy";
import { FiltersProxy } from "./FiltersProxy";
import { PaginationSelectorProxy } from "./PaginationSelectorProxy";

// Port of Signum.Playwright's Search/SearchPageProxy.cs — a whole `/find/<Query>` page, typed on the row
// the query yields (`b.searchPage(OrderEntity)` → `SearchPageProxy<OrderEntity>`), so every token below is
// a property lambda over that row.
export class SearchPageProxy<T extends BaseEntity> implements AsyncScoped {

    /** A search page is a SCOPE (see PlaywrightExtensions' AsyncScoped) so it chains with `.scoped(...)`
     *  the way Signum's `b.SearchPageAsync(...).Then(async persons => …)` does. Nothing to close. */
    async [Symbol.asyncDispose](): Promise<void> { }


    private constructor(readonly page: Page, readonly searchControl: SearchControlProxy<T>) { }

    /** Signum's `SearchPageProxy.NewAsync(page)`. */
    static async create<T extends BaseEntity>(page: Page, queryName: Type<T> & QueryName, waitInitialSearch = true): Promise<SearchPageProxy<T>> {
        const element = page.locator(".sf-search-page .sf-search-control").first();
        await waitVisible(element);

        const proxy = new SearchPageProxy<T>(page, new SearchControlProxy<T>(element, queryName));
        if (waitInitialSearch)
            await proxy.searchControl.waitInitialSearchCompleted();
        return proxy;
    }

    get results(): ResultTableProxy<T> { return this.searchControl.results; }
    get filters(): FiltersProxy<T> { return this.searchControl.filters; }
    get pagination(): PaginationSelectorProxy { return this.searchControl.pagination; }

    search(): Promise<void> { return this.searchControl.search(); }

    /** The token STRINGS of these columns — what the DOM carries, in the order given. */
    tokens(...tokens: TokenOf<T>[]): string[] { return tokens.map(t => tokenString<T>(t)); }

    /** Signum's `CreateAsync<T>` — the page's Create button, which opens a modal SCOPE. */
    createModal<E extends Entity = T extends Entity ? T : never>(type?: Type<E>): Scope<FrameModalProxy<E>> {
        return scope(this.searchControl.createModal<E>(type));
    }
}
