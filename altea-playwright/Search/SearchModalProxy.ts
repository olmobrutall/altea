import type { Locator } from "playwright";
import type { Lite } from "@altea/altea/data/lite";
import type { BaseEntity, Entity, Type } from "@altea/altea/data/entity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { waitNotPresent, waitVisible, type AsyncScoped } from "../PlaywrightExtensions";
import { ModalProxy } from "../ModalProxies/ModalProxy";
import { SearchControlProxy } from "./SearchControlProxy";
import type { ResultTableProxy } from "./ResultTableProxy";
import type { FiltersProxy } from "./FiltersProxy";

// Port of Signum.Playwright's Search/SearchModalProxy.cs — the search a FIND button opens: filter, pick a
// row, accept.
export class SearchModalProxy<T extends BaseEntity> extends ModalProxy implements AsyncScoped {

    private closed = false;

    /** Signum's ModalProxy.DisposeAsync — close it if the body did not (see FrameModalProxy). */
    async [Symbol.asyncDispose](): Promise<void> {
        if (this.closed)
            return;
        try {
            if (await this.modal.isVisible())
                await this.close();
        } catch { /* best effort on the way out */ }
        finally { await this.disposing?.(false); }
    }


    private constructor(modal: Locator, readonly searchControl: SearchControlProxy<T>) {
        super(modal);
    }

    static async create<T extends BaseEntity>(modal: Locator, queryName: Type<T> & QueryName, waitInitialSearch = true): Promise<SearchModalProxy<T>> {
        await waitVisible(modal);
        const element = modal.locator(".sf-search-control").first();
        await waitVisible(element);

        const proxy = new SearchModalProxy<T>(modal, new SearchControlProxy<T>(element, queryName));
        if (waitInitialSearch)
            await proxy.searchControl.waitInitialSearchCompleted();
        return proxy;
    }

    get results(): ResultTableProxy<T> { return this.searchControl.results; }
    get filters(): FiltersProxy<T> { return this.searchControl.filters; }

    get okButton(): Locator { return this.modal.locator(".sf-entity-button.sf-ok-button, .sf-ok-button").first(); }

    /** Signum's `SelectLiteAsync` — check the row of THAT entity and accept. */
    async selectLite(lite: Lite<T & Entity> | (T & Entity)): Promise<void> {
        await this.results.rowOf(lite).locator("input.sf-td-selection").check();
        await this.ok();
    }

    /** Pick by row index. */
    async selectRow(index: number): Promise<void> {
        await this.results.selectRow(index);
        await this.ok();
    }

    /** Double-click a row — the shortcut that both selects and accepts. */
    async doubleClickRow(index: number): Promise<void> {
        await this.results.row(index).dblclick();
        await waitNotPresent(this.modal);
    }

    async ok(): Promise<void> {
        await this.okButton.click();
        await waitNotPresent(this.modal);
        this.closed = true;
        await this.disposing?.(true);
    }
}
