import type { Locator } from "playwright";
import type { BaseEntity, Entity, Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import {
    FilterGroupOperation, FilterOperation,
    type FilterGroupOperationKeys, type FilterOperationKeys,
} from "@altea/altea/data/dynamicQueries";
import { waitVisible } from "../PlaywrightExtensions";
import { editorText, enumName, filterOperationName, tokenString, tryRouteOf, type TokenOf } from "../tokens";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { QueryTokenBuilderProxy } from "./QueryTokenBuilderProxy";

// Port of Signum.Playwright's Search/FiltersProxy.cs + FilterOptionProxy.cs — the filter panel: add a
// condition or a group, set its token / operation / value, remove them.
//
// Everything a filter is made of is typed: the token is a property lambda over the query's row, the
// operation is `FilterOperation`, and the value is whatever that property holds — an enum MEMBER, a lite,
// a string. Signum's proxy takes three strings.
export class FiltersProxy<T extends BaseEntity> {

    constructor(readonly element: Locator, readonly queryName: Type<T> & QueryName) { }

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
    async addFilter(): Promise<FilterConditionProxy<T>> {
        const before = await this.count();
        await this.addFilterButton.click();
        await waitVisible(this.rows.nth(before));
        return new FilterConditionProxy<T>(this.rows.nth(before), this.queryName);
    }

    /** Signum's `AddGroupAsync()`. */
    async addGroup(): Promise<FilterGroupProxy<T>> {
        const before = await this.count();
        await this.addGroupButton.click();
        await waitVisible(this.rows.nth(before));
        return new FilterGroupProxy<T>(this.rows.nth(before), this.queryName);
    }

    /** Signum's three-argument `AddFilterAsync(token, operation, value)` — the shorthand tests use. */
    async addFilterFor<S>(token: TokenOf<T, S>, operation?: FilterOperation | FilterOperationKeys | null,
        value?: FilterValue<S> | null): Promise<FilterConditionProxy<T>> {

        const filter = await this.addFilter();
        await filter.queryToken.setToken(tokenString<T>(token as TokenOf<T>));
        // The route is what knows the column's ENUM, whose editor holds member NAMES (see setValue).
        filter.route = tryRouteOf<T>(this.queryName, token as TokenOf<T>);
        if (operation != null)
            await filter.setOperation(operation);
        if (value !== undefined && value !== null)
            await filter.setValue(value);
        return filter;
    }

    /** Signum's `GetFilterAsync(index)`. */
    filterAt(index: number): FilterConditionProxy<T> {
        return new FilterConditionProxy<T>(this.rows.nth(index), this.queryName);
    }

    async removeAll(): Promise<void> {
        await this.removeAllButton.click();
    }

    async isAddFilterEnabled(): Promise<boolean> {
        return await this.addFilterButton.isEnabled();
    }
}

/**
 * What a filter can be set to, given the token's type `S`: the value itself, an enum MEMBER (the editor
 * holds its name), or an entity / lite (the editor holds its key).
 */
export type FilterValue<S> = S extends Lite<infer E> ? Lite<E> | E : S;

/** Signum's FilterConditionProxy — one `token / operation / value` row. */
export class FilterConditionProxy<T extends BaseEntity> {

    constructor(readonly element: Locator, readonly queryName: Type<T> & QueryName) { }

    /** The route this filter's token names, when it names one — set by `addFilterFor`. See setValue. */
    route: PropertyRoute | undefined;

    get queryToken(): QueryTokenBuilderProxy {
        return new QueryTokenBuilderProxy(this.element.locator(".sf-query-token-builder"));
    }

    get operationElement(): Locator { return this.element.locator("td.sf-filter-operation select"); }
    get valueElement(): Locator { return this.element.locator("td.sf-filter-value > *").first(); }
    get deleteButton(): Locator { return this.element.locator(".sf-line-button.sf-remove").first(); }

    /** The operation currently selected. */
    async getOperation(): Promise<FilterOperationKeys> {
        return await this.operationElement.inputValue() as FilterOperationKeys;
    }

    async setOperation(operation: FilterOperation | FilterOperationKeys): Promise<void> {
        await this.operationElement.selectOption(filterOperationName(operation));
    }

    /**
     * Set the filter's value. The editor depends on the token's type — a text box, a number box, a combo,
     * an entity line — so this writes into whatever `td.sf-filter-value` holds: an `<input>`/`<textarea>` is
     * filled, a `<select>` is selected, and a checkbox is checked. An ENTITY value is matched by its lite
     * key in the combo, or typed into the autocomplete.
     */
    async setValue(value: unknown): Promise<void> {
        const text = editorText(value, this.route);
        const cell = this.element.locator("td.sf-filter-value");

        const select = cell.locator("select");
        if (await select.count() > 0) {
            await select.first().selectOption(text);
            return;
        }

        const input = cell.locator("input:not([type=checkbox]), textarea");
        if (await input.count() > 0) {
            await input.first().fill(text);
            await input.first().press("Enter");
            return;
        }

        const checkbox = cell.locator("input[type=checkbox]");
        if (await checkbox.count() > 0) {
            if (value === true || text === "true")
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
export class FilterGroupProxy<T extends BaseEntity> {

    constructor(readonly element: Locator, readonly queryName: Type<T> & QueryName) { }

    get groupOperationElement(): Locator { return this.element.locator("select").first(); }
    get deleteButton(): Locator { return this.element.locator(".sf-line-button.sf-remove").first(); }

    async setGroupOperation(operation: FilterGroupOperation | FilterGroupOperationKeys): Promise<void> {
        await this.groupOperationElement.selectOption(enumName(FilterGroupOperation, operation));
    }

    /** The nested filters of this group. */
    get filters(): FiltersProxy<T> { return new FiltersProxy<T>(this.element, this.queryName); }

    async delete(): Promise<void> {
        await this.deleteButton.click();
    }
}
