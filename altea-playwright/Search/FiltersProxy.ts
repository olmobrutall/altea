import type { Locator } from "@playwright/test";
import { waitVisible } from "../PlaywrightExtensions";
import { QueryTokenBuilderProxy } from "./QueryTokenBuilderProxy";

// Port of Signum.Playwright's Search/FiltersProxy.cs + FilterOptionProxy.cs — the filter panel: add a
// condition or a group, set its token / operation / value, remove them.
export class FiltersProxy {

    constructor(readonly element: Locator, readonly queryKey: string) { }

    get addFilterButton(): Locator { return this.element.locator(".sf-line-button.sf-create-condition").first(); }
    get addGroupButton(): Locator { return this.element.locator(".sf-line-button.sf-create-group").first(); }
    get removeAllButton(): Locator { return this.element.locator("thead th .sf-remove").first(); }

    /**
     * Every filter row currently in the panel.
     *
     * NOTE the class filter: altea's filter table ends with a `tr.sf-filter-create` row (the one holding
     * the add buttons), so a plain `tbody > tr` — which is what Signum's proxy uses — counts it as a filter
     * and addresses the wrong row after an add.
     */
    get rows(): Locator {
        return this.element.locator("table > tbody > tr.sf-filter-condition, table > tbody > tr.sf-filter-group");
    }

    count(): Promise<number> { return this.rows.count(); }

    /** Signum's `AddFilterAsync()` — add an empty condition and return it. */
    async addFilter(): Promise<FilterConditionProxy> {
        const before = await this.count();
        await this.addFilterButton.click();
        await waitVisible(this.rows.nth(before));
        return new FilterConditionProxy(this.rows.nth(before), this.queryKey);
    }

    /** Signum's `AddGroupAsync()`. */
    async addGroup(): Promise<FilterGroupProxy> {
        const before = await this.count();
        await this.addGroupButton.click();
        await waitVisible(this.rows.nth(before));
        return new FilterGroupProxy(this.rows.nth(before), this.queryKey);
    }

    /** Signum's three-argument `AddFilterAsync(token, operation, value)` — the shorthand tests use. */
    async addFilterFor(token: string, operation: string | null, value: string | null): Promise<FilterConditionProxy> {
        const filter = await this.addFilter();
        await filter.queryToken.setToken(token);
        if (operation != null)
            await filter.setOperation(operation);
        if (value != null)
            await filter.setValue(value);
        return filter;
    }

    /** Signum's `GetFilterAsync(index)`. */
    filterAt(index: number): FilterConditionProxy {
        return new FilterConditionProxy(this.rows.nth(index), this.queryKey);
    }

    async removeAll(): Promise<void> {
        await this.removeAllButton.click();
    }

    async isAddFilterEnabled(): Promise<boolean> {
        return await this.addFilterButton.isEnabled();
    }
}

/** Signum's FilterConditionProxy — one `token / operation / value` row. */
export class FilterConditionProxy {

    constructor(readonly element: Locator, readonly queryKey: string) { }

    get queryToken(): QueryTokenBuilderProxy {
        return new QueryTokenBuilderProxy(this.element.locator(".sf-query-token-builder"));
    }

    get operationElement(): Locator { return this.element.locator("td.sf-filter-operation select"); }
    get valueElement(): Locator { return this.element.locator("td.sf-filter-value > *").first(); }
    get deleteButton(): Locator { return this.element.locator(".sf-line-button.sf-remove").first(); }

    /** The operation's VALUE is the FilterOperation member name ("EqualTo", "Contains", …). */
    async getOperation(): Promise<string> {
        return await this.operationElement.inputValue();
    }

    async setOperation(operation: string): Promise<void> {
        await this.operationElement.selectOption(operation);
    }

    /**
     * Set the filter's value. The editor depends on the token's type — a text box, a number box, a combo,
     * an entity line — so this writes into whatever `td.sf-filter-value` holds: an `<input>`/`<textarea>` is
     * filled, a `<select>` is selected, and anything else is left to the caller (use `valueElement`).
     */
    async setValue(value: string): Promise<void> {
        const cell = this.element.locator("td.sf-filter-value");
        const select = cell.locator("select");
        if (await select.count() > 0) {
            await select.first().selectOption(value);
            return;
        }

        const input = cell.locator("input:not([type=checkbox]), textarea");
        if (await input.count() > 0) {
            await input.first().fill(value);
            await input.first().press("Enter");
            return;
        }

        const checkbox = cell.locator("input[type=checkbox]");
        if (await checkbox.count() > 0) {
            if (value === "true")
                await checkbox.first().check();
            else
                await checkbox.first().uncheck();
            return;
        }

        throw new Error("FilterConditionProxy.setValue: no recognisable editor in td.sf-filter-value —"
            + " drive it through `valueElement` (an entity filter needs the EntityLine proxy).");
    }

    async delete(): Promise<void> {
        await this.deleteButton.click();
    }
}

/** Signum's FilterGroupProxy — an AND/OR group that holds nested filters. */
export class FilterGroupProxy {

    constructor(readonly element: Locator, readonly queryKey: string) { }

    get groupOperationElement(): Locator { return this.element.locator("select").first(); }
    get deleteButton(): Locator { return this.element.locator(".sf-line-button.sf-remove").first(); }

    /** "And" / "Or". */
    async setGroupOperation(operation: string): Promise<void> {
        await this.groupOperationElement.selectOption(operation);
    }

    /** The nested filters of this group. */
    get filters(): FiltersProxy { return new FiltersProxy(this.element, this.queryKey); }

    async delete(): Promise<void> {
        await this.deleteButton.click();
    }
}
