import type { Locator } from "playwright";
import type { Lite } from "@altea/altea/data/lite";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { OrderType, type OrderTypeKeys } from "@altea/altea/data/dynamicQueries";
import type { FrameModalProxy } from "../Frames/FrameModalProxy"; // lazily imported below (cycle)
import { captureOnClick, scope, waitVisible, type Scope } from "../PlaywrightExtensions";
import { orderTypeName, tokenString, type TokenOf } from "../tokens";
import { liteFromKey } from "../liteKeys";

// Port of Signum.Playwright's Search/ResultTableProxy.cs — the rows a search returned: read a cell, select
// rows, sort, remove a column, open an entity.
//
// altea renders the same contract Signum's proxy reads: `tbody > tr[data-entity]` (the lite key),
// `td[data-column-index]`, `thead th[data-column-name]` and `input.sf-td-selection` — so the port is the
// same code in JS. What differs is the API: a column is a property lambda, and a row hands back a real
// `Lite<T>` rather than the `"Order;3"` string the attribute holds.
export class ResultTableProxy<T extends BaseEntity> {

    constructor(readonly element: Locator, readonly queryName: Type<T>) { }

    get table(): Locator { return this.element.locator("table.sf-search-results"); }
    get rows(): Locator { return this.element.locator("table.sf-search-results > tbody > tr[data-entity]"); }
    get header(): Locator { return this.element.locator("thead > tr"); }

    rowsCount(): Promise<number> { return this.rows.count(); }

    /** One row, by index. */
    row(index: number): Locator { return this.rows.nth(index); }

    /** One row, by the entity it shows (Signum's `Row(lite, subRowIndex)`). */
    rowOf(lite: Lite<Entity> | Entity, subRowIndex?: number): Locator {
        const key = lite instanceof Entity ? lite.toLite().key() : lite.key();
        const rows = this.element.locator(`table.sf-search-results > tbody > tr[data-entity='${key}']`);
        return subRowIndex == null ? rows.first() : rows.nth(subRowIndex);
    }

    /** Every row's entity, in order (Signum reads the raw `data-entity` keys). */
    async lites(): Promise<Lite<T & Entity>[]> {
        const keys = await this.rows.evaluateAll(els => els.map(e => e.getAttribute("data-entity") ?? ""));
        return keys.map(k => liteFromKey<T & Entity>(k));
    }

    /** The entity of ONE row — what a test takes hold of to navigate to it or assert on it. */
    async liteAt(rowIndex: number): Promise<Lite<T & Entity>> {
        const key = await this.row(rowIndex).getAttribute("data-entity");
        if (key == null)
            throw new Error(`The result table has no row ${rowIndex} (it has ${await this.rowsCount()}).`);
        return liteFromKey<T & Entity>(key);
    }

    // ---- Columns -----------------------------------------------------------------------------------

    /** Signum's `GetColumnTokensAsync` — the tokens the table is currently showing. */
    async columnTokens(): Promise<string[]> {
        const tokens = await this.header.locator("th[data-column-name]")
            .evaluateAll(els => els.map(e => e.getAttribute("data-column-name") ?? ""));
        return tokens;
    }

    /** Signum's `GetColumnIndexAsync`. */
    async columnIndex(token: TokenOf<T>): Promise<number> {
        const key = tokenString<T>(token);
        const index = (await this.columnTokens()).indexOf(key);
        if (index < 0)
            throw new Error(`The result table has no column '${key}' (has: ${(await this.columnTokens()).join(", ")})`);
        return index;
    }

    hasColumn(token: TokenOf<T>): Promise<boolean> {
        return this.headerCell(token).count().then(c => c > 0);
    }

    headerCell(token: TokenOf<T>): Locator {
        return this.header.locator(`th[data-column-name='${tokenString<T>(token)}']`);
    }

    /** The CELL of one row / column (Signum's `CellElementAsync`). */
    async cell(rowIndex: number, token: TokenOf<T>): Promise<Locator> {
        const index = await this.columnIndex(token);
        return this.row(rowIndex).locator(`td[data-column-index='${index}']`);
    }

    /** The text of one cell — the assertion most tests actually make. */
    async cellText(rowIndex: number, token: TokenOf<T>): Promise<string> {
        return ((await (await this.cell(rowIndex, token)).textContent()) ?? "").trim();
    }

    /** Signum's `RemoveColumnAsync`. */
    async removeColumn(token: TokenOf<T>): Promise<void> {
        await this.headerCell(token).click({ button: "right" });
        const menu = this.element.page().locator(".sf-context-menu .dropdown-menu");
        await waitVisible(menu);
        await menu.locator(".sf-remove-header, .sf-remove").first().click();
    }

    /** Signum's `OrderByAsync` — click (or shift-click, for a "then by") a header. */
    async orderBy(token: TokenOf<T>, orderType: OrderType | OrderTypeKeys = OrderType.Ascending, options?: { thenBy?: boolean }): Promise<void> {
        const cell = this.headerCell(token);
        await cell.click(options?.thenBy ? { modifiers: ["Shift"] } : undefined);
        // A second click on the same header flips it: the control cycles ascending → descending.
        if (orderTypeName(orderType) === "Descending")
            await cell.click(options?.thenBy ? { modifiers: ["Shift"] } : undefined);
    }

    // ---- Selection ---------------------------------------------------------------------------------

    async selectRow(...indexes: number[]): Promise<void> {
        for (const index of indexes)
            await this.row(index).locator("input.sf-td-selection").check();
    }

    async selectAllRows(): Promise<void> {
        await this.header.locator("input.sf-td-selection").check();
    }

    /** Signum's `SelectedEntitiesAsync` — the checked rows' entities. */
    async selectedLites(): Promise<Lite<T & Entity>[]> {
        const keys = await this.rows.evaluateAll(els => els
            .filter(e => (e.querySelector("input.sf-td-selection") as HTMLInputElement | null)?.checked)
            .map(e => e.getAttribute("data-entity") ?? ""));
        return keys.map(k => liteFromKey<T & Entity>(k));
    }

    // ---- Navigation --------------------------------------------------------------------------------

    /** The entity LINK of a row (its first cell's anchor). */
    entityLink(rowIndex: number): Locator {
        return this.row(rowIndex).locator("td:nth-child(2):not([data-column-index]) a, a.sf-entity-link").first();
    }

    /**
     * Signum's `EntityClickAsync<T>` — open the row's entity in a modal SCOPE (see FrameModalProxy). The
     * type comes from the query; pass one only for a polymorphic query, to say which implementation the
     * row is.
     */
    entityClickModal<E extends Entity = T extends Entity ? T : never>(rowIndex: number, type?: Type<E>): Scope<FrameModalProxy<E>> {
        return scope((async () => {
            const modal = await captureOnClick(this.entityLink(rowIndex));
            const { FrameModalProxy } = await import("../Frames/FrameModalProxy");
            return await FrameModalProxy.create<E>(modal, (type ?? this.queryName) as Type<E>);
        })());
    }

    /** Signum's `EntityClickInPlaceAsync<T>` — navigate to the row's entity PAGE. */
    async entityClickInPlace(rowIndex: number): Promise<void> {
        await this.entityLink(rowIndex).click({ modifiers: ["Control"] });
    }
}
