import type { Locator } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { EntityBaseProxy } from "./EntityBaseProxy";
import { LineContainer } from "../Frames/LineContainer";
import { waitChanges } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityTableProxy.cs (EntityTable.tsx) — a collection edited as a
// grid, one ROW per element.
export class EntityTableProxy extends EntityBaseProxy {

    override get itemRoute(): PropertyRoute { return this.route.add("Item"); }

    get rows(): Locator { return this.element.locator("table > tbody > tr").filter({ has: this.element.page().locator("[data-property-path]") }); }

    count(): Promise<number> { return this.rows.count(); }

    /** The lines of ONE row (Signum's `RowLineContainer<T>`). */
    rowAt<T extends BaseEntity>(index: number): LineContainer<T> {
        return new LineContainer<T>(this.rows.nth(index), this.itemRoute);
    }

    /** Add a row and return its lines. */
    async createRow<T extends BaseEntity>(): Promise<LineContainer<T>> {
        const before = await this.count();
        await waitChanges(this.element, () => this.createButton.click());
        return this.rowAt<T>(before);
    }

    async removeRow(index: number): Promise<void> {
        await waitChanges(this.element, () => this.rows.nth(index).locator("a.sf-remove").first().click());
    }

    override async getValueUntyped(): Promise<unknown> { return await this.count(); }

    override async setValueUntyped(): Promise<void> {
        throw new Error("EntityTableProxy: a collection is edited row by row — use createRow() /"
            + " removeRow() / rowAt().");
    }
}
