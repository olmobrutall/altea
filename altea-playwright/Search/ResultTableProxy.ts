import type { Locator } from "@playwright/test";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity, EntityType } from "@altea/altea/data/entity";
import type { FrameModalProxy } from "../Frames/FrameModalProxy"; // lazily imported below (cycle)
import { captureOnClick, waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's Search/ResultTableProxy.cs — the rows a search returned: read a cell, select
// rows, sort, remove a column, open an entity.
//
// altea renders the same contract Signum's proxy reads: `tbody > tr[data-entity]` (the lite key),
// `td[data-column-index]`, `thead th[data-column-name]` and `input.sf-td-selection` — so the port is the
// same code in JS.
export class ResultTableProxy {

    constructor(readonly element: Locator) { }

    get table(): Locator { return this.element.locator("table.sf-search-results"); }
    get rows(): Locator { return this.element.locator("table.sf-search-results > tbody > tr[data-entity]"); }
    get header(): Locator { return this.element.locator("thead > tr"); }

    rowsCount(): Promise<number> { return this.rows.count(); }

    /** One row, by index. */
    row(index: number): Locator { return this.rows.nth(index); }

    /** One row, by the entity it shows (Signum's `Row(lite, subRowIndex)`). */
    rowOf(lite: Lite<Entity>, subRowIndex?: number): Locator {
        const rows = this.element.locator(`table.sf-search-results > tbody > tr[data-entity='${lite.key()}']`);
        return subRowIndex == null ? rows.first() : rows.nth(subRowIndex);
    }

    /** Every row's `data-entity` (the lite keys), in order. */
    async entityKeys(): Promise<string[]> {
        const keys = await this.rows.evaluateAll(els => els.map(e => e.getAttribute("data-entity") ?? ""));
        return keys;
    }

    // ---- Columns -----------------------------------------------------------------------------------

    /** Signum's `GetColumnTokensAsync` — the tokens the table is currently showing. */
    async columnTokens(): Promise<string[]> {
        const tokens = await this.header.locator("th[data-column-name]")
            .evaluateAll(els => els.map(e => e.getAttribute("data-column-name") ?? ""));
        return tokens;
    }

    /** Signum's `GetColumnIndexAsync`. */
    async columnIndex(token: string): Promise<number> {
        const index = (await this.columnTokens()).indexOf(token);
        if (index < 0)
            throw new Error(`The result table has no column '${token}' (has: ${(await this.columnTokens()).join(", ")})`);
        return index;
    }

    hasColumn(token: string): Promise<boolean> {
        return this.headerCell(token).count().then(c => c > 0);
    }

    headerCell(token: string): Locator {
        return this.header.locator(`th[data-column-name='${token}']`);
    }

    /** The CELL of one row / column (Signum's `CellElementAsync`). */
    async cell(rowIndex: number, token: string): Promise<Locator> {
        const index = await this.columnIndex(token);
        return this.row(rowIndex).locator(`td[data-column-index='${index}']`);
    }

    /** The text of one cell — the assertion most tests actually make. */
    async cellText(rowIndex: number, token: string): Promise<string> {
        return ((await (await this.cell(rowIndex, token)).textContent()) ?? "").trim();
    }

    /** Signum's `RemoveColumnAsync`. */
    async removeColumn(token: string): Promise<void> {
        await this.headerCell(token).click({ button: "right" });
        const menu = this.element.page().locator(".sf-context-menu .dropdown-menu");
        await waitVisible(menu);
        await menu.locator(".sf-remove-header, .sf-remove").first().click();
    }

    /** Signum's `OrderByAsync` — click (or shift-click, for a "then by") a header. */
    async orderBy(token: string, options?: { descending?: boolean; thenBy?: boolean }): Promise<void> {
        const cell = this.headerCell(token);
        await cell.click(options?.thenBy ? { modifiers: ["Shift"] } : undefined);
        if (options?.descending)
            await cell.click(options.thenBy ? { modifiers: ["Shift"] } : undefined);
    }

    // ---- Selection ---------------------------------------------------------------------------------

    async selectRow(...indexes: number[]): Promise<void> {
        for (const index of indexes)
            await this.row(index).locator("input.sf-td-selection").check();
    }

    async selectAllRows(): Promise<void> {
        await this.header.locator("input.sf-td-selection").check();
    }

    /** Signum's `SelectedEntitiesAsync` — the lite keys of the checked rows. */
    async selectedEntityKeys(): Promise<string[]> {
        const keys = await this.rows.evaluateAll(els => els
            .filter(e => (e.querySelector("input.sf-td-selection") as HTMLInputElement | null)?.checked)
            .map(e => e.getAttribute("data-entity") ?? ""));
        return keys;
    }

    // ---- Navigation --------------------------------------------------------------------------------

    /** The entity LINK of a row (its first cell's anchor). */
    entityLink(rowIndex: number): Locator {
        return this.row(rowIndex).locator("td:nth-child(2):not([data-column-index]) a, a.sf-entity-link").first();
    }

    /** Signum's `EntityClickAsync<T>` — open the row's entity in a modal SCOPE (see FrameModalProxy). */
    async entityClickModal<T extends Entity>(rowIndex: number, rootType: EntityType<T>): Promise<FrameModalProxy<T>> {
        const modal = await captureOnClick(this.entityLink(rowIndex));
        const { FrameModalProxy } = await import("../Frames/FrameModalProxy");
        return await FrameModalProxy.create<T>(modal, rootType as unknown as Function);
    }

    /** Signum's `EntityClickInPlaceAsync<T>` — navigate to the row's entity PAGE. */
    async entityClickInPlace(rowIndex: number): Promise<void> {
        await this.entityLink(rowIndex).click({ modifiers: ["Control"] });
    }
}
