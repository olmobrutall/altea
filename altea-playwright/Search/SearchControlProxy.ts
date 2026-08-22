import type { Locator, Page } from "@playwright/test";
import type { BaseEntity, Entity, EntityType } from "@altea/altea/data/entity";
import type { FrameModalProxy } from "../Frames/FrameModalProxy"; // lazily imported below (cycle)
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { captureOnClick, waitFor, waitVisible, defaultTimeout } from "../PlaywrightExtensions";
import { LineContainer } from "../Frames/LineContainer";
import { ResultTableProxy } from "./ResultTableProxy";
import { FiltersProxy } from "./FiltersProxy";
import { PaginationSelectorProxy } from "./PaginationSelectorProxy";

// Port of Signum.Playwright's Search/SearchControlProxy.cs — one SearchControl: search, filter, paginate,
// read the results.
//
// The load handshake is Signum's and works unchanged: altea's SearchControlLoaded renders
// `data-search-count`, a counter it bumps when a search RESOLVES, so "wait until the search finished" is
// "wait until that number changed" — no sleeps, no guessing at spinners.
export class SearchControlProxy {

    readonly results: ResultTableProxy;

    constructor(readonly element: Locator, readonly queryKey: string) {
        this.results = new ResultTableProxy(element.locator(".sf-scroll-table-container"));
    }

    get page(): Page { return this.element.page(); }

    get filters(): FiltersProxy { return new FiltersProxy(this.filtersPanel, this.queryKey); }
    get pagination(): PaginationSelectorProxy { return new PaginationSelectorProxy(this.element); }

    get searchButton(): Locator { return this.element.locator(".sf-query-button.sf-search"); }
    get createButton(): Locator { return this.element.locator(".sf-create").first(); }
    get toggleFiltersButton(): Locator { return this.element.locator(".sf-filter-button"); }
    get filtersPanel(): Locator { return this.element.locator(".sf-filters-list"); }
    get contextMenu(): Locator { return this.page.locator(".sf-context-menu"); }

    /** Signum's `SearchAsync` — click Search and wait for the results to land. */
    async search(): Promise<void> {
        await this.waitSearchCompleted(() => this.searchButton.click());
    }

    /** Signum's `WaitSearchCompletedAsync(trigger)` — run something that searches, then wait for it. */
    async waitSearchCompleted(trigger: () => Promise<void>): Promise<void> {
        const before = await this.element.getAttribute("data-search-count");
        await trigger();
        await this.waitSearchCountChanged(before);
    }

    /** Signum's `WaitInitialSearchCompletedAsync` — the search a page runs on open. */
    async waitInitialSearchCompleted(): Promise<void> {
        await this.waitSearchCountChanged(null);
    }

    private async waitSearchCountChanged(previous: string | null, timeout = defaultTimeout): Promise<void> {
        await waitFor(async () => {
            const now = await this.element.getAttribute("data-search-count");
            return now != null && now !== previous;
        }, "the search to complete (data-search-count to change)", timeout);
    }

    /** Signum's `ToggleFiltersAsync`. */
    async toggleFilters(show: boolean): Promise<void> {
        if (await this.filtersPanel.isVisible() === show)
            return;
        await this.toggleFiltersButton.click();
        if (show)
            await waitVisible(this.filtersPanel);
        else
            await this.filtersPanel.waitFor({ state: "hidden" });
    }

    filtersVisible(): Promise<boolean> { return this.filtersPanel.isVisible(); }

    /** Signum's `WaitContextMenuAsync` — the menu a right-click on a cell / header opened. */
    async waitContextMenu(): Promise<Locator> {
        const menu = this.page.locator(".sf-context-menu .dropdown-menu");
        await waitVisible(menu);
        return menu;
    }

    /** Signum's `AddQuickFilterAsync(rowIndex, token)` — right-click a cell, "Add filter". */
    async addQuickFilter(rowIndex: number, token: string): Promise<void> {
        await (await this.results.cell(rowIndex, token)).click({ button: "right" });
        const menu = await this.waitContextMenu();
        await menu.locator(".sf-quickfilter-header a").first().click();
    }

    /** Signum's `CreateAsync<T>` — the Create button, which opens a modal SCOPE (see FrameModalProxy). */
    async createModal<T extends Entity>(rootType: EntityType<T>): Promise<FrameModalProxy<T>> {
        const modal = await captureOnClick(this.createButton);
        const { FrameModalProxy } = await import("../Frames/FrameModalProxy");
        return await FrameModalProxy.create<T>(modal, rootType as unknown as Function);
    }

    /** Signum's `SimpleFilterBuilder<T>` — the app-supplied filter form, as a line container. */
    simpleFilterBuilder<T extends BaseEntity>(rootType: Function): LineContainer<T> {
        return new LineContainer<T>(this.element.locator(".simple-filter-builder"), PropertyRoute.root(rootType));
    }

    /**
     * Signum's `HasMultiplyMessageAsync`. altea renders the "rows are multiplied" notice as
     * `MultipliedMessage` rather than Signum's `.sf-td-multiply` cell class, so this asks the component's
     * own container — the only selector in this port that is NOT the one Signum uses.
     */
    async hasMultiplyMessage(): Promise<boolean> {
        return await this.element.locator(".sf-td-multiply, .sf-search-multiplied").count() > 0;
    }
}
