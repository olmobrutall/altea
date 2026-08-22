import type { Locator } from "@playwright/test";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { waitNotPresent, waitVisible, type AsyncScoped } from "../PlaywrightExtensions";
import { ModalProxy } from "../ModalProxies/ModalProxy";
import { SearchControlProxy } from "./SearchControlProxy";
import type { ResultTableProxy } from "./ResultTableProxy";
import type { FiltersProxy } from "./FiltersProxy";

// Port of Signum.Playwright's Search/SearchModalProxy.cs — the search a FIND button opens: filter, pick a
// row, accept.
export class SearchModalProxy extends ModalProxy implements AsyncScoped {

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


    private constructor(modal: Locator, readonly searchControl: SearchControlProxy) {
        super(modal);
    }

    static async create(modal: Locator, queryKey: string, waitInitialSearch = true): Promise<SearchModalProxy> {
        await waitVisible(modal);
        const element = modal.locator(".sf-search-control").first();
        await waitVisible(element);

        const proxy = new SearchModalProxy(modal, new SearchControlProxy(element, queryKey));
        if (waitInitialSearch)
            await proxy.searchControl.waitInitialSearchCompleted();
        return proxy;
    }

    get results(): ResultTableProxy { return this.searchControl.results; }
    get filters(): FiltersProxy { return this.searchControl.filters; }

    get okButton(): Locator { return this.modal.locator(".sf-entity-button.sf-ok-button, .sf-ok-button").first(); }

    /** Signum's `SelectLiteAsync` — check the row of THAT entity and accept. */
    async selectLite(lite: Lite<Entity>): Promise<void> {
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
