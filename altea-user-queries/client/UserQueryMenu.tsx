import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type {
    FilterOptionParsed, ColumnOptionParsed, OrderOptionParsed, FilterOption, PinnedFilter,
} from "@altea/altea/client/FindOptions";
import { isFilterGroup } from "@altea/altea/client/FindOptions";
import { Enum } from "@altea/altea/data/enum";
import { Temporal } from "@altea/altea/data/basics";
import {
    RefreshModeEnum, ColumnOptionsModeEnum, PaginationModeEnum, CombineRowsEnum, OrderTypeEnum,
    SystemTimeModeEnum, SystemTimeJoinModeEnum, TimeSeriesUnitEnum,
} from "@altea/altea/data/dynamicQueries";
import type { SystemTime } from "@altea/altea/data/dynamicQuery/queryRequest";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    UserQueryEntity, UserQueryMessage, UserQueryEntity_Columns, UserQueryEntity_Orders, UserQueryEntity_Filters, SystemTimeEmbedded,
} from "../data/UserQuery";
import { UserQueriesClient } from "./UserQueriesClient";
import { filterOptionsParsedToEmbedded } from "./Templates/FilterBuilderEmbedded";
import StringDistance from "./StringDistance";

// Port of Signum's Signum.UserQueries/UserQueryMenu.tsx — the dropdown in a SearchControl toolbar to list /
// apply / edit / create saved queries. altea divergences:
//  - Uses altea's SearchControlLoaded (props.queryToken, handleChangeFiltermode, doSearchPage1) and builds
//    the new UserQuery client-side from the parsed FindOptions (Finder.toFindOptions), with the QueryEntity
//    resolved via a server round-trip (UserQueriesClient.API.queryEntity).
//  - "Apply changes" (Signum's StringDistance merge of the old vs. new definition) is DEFERRED — the menu
//    offers list / apply / back-to-default / edit / create for now.
//  - No `getCurrentUserQuery`/title-breadcrumb augmentation (deferred with the search-page title hook).

export interface UserQueryMenuProps {
    searchControl: SearchControlLoaded;
    isHidden: boolean;
}

export default function UserQueryMenu(p: UserQueryMenuProps): React.JSX.Element | null {
    const [isOpen, setIsOpen] = React.useState(false);
    const [currentUserQuery, setCurrentUserQueryState] = React.useState<Lite<UserQueryEntity> | undefined>();
    const [userQueries, setUserQueries] = React.useState<Lite<UserQueryEntity>[] | undefined>(undefined);
    const forceUpdate = useForceUpdate();

    if (p.isHidden)
        return null;

    function setCurrentUserQuery(uq: Lite<UserQueryEntity> | undefined): void {
        p.searchControl.extraUrlParams.userQuery = uq && uq.key();
        setCurrentUserQueryState(uq);
        p.searchControl.props.onPageTitleChanged?.();
    }

    function handleToggle(open: boolean): void {
        if (open && userQueries == undefined)
            reloadList();
        setIsOpen(open);
    }

    function reloadList(): Promise<Lite<UserQueryEntity>[]> {
        return UserQueriesClient.API.forQuery(p.searchControl.props.findOptions.queryKey)
            .then(list => { setUserQueries(list); return list; });
    }

    function applyUserQueryToSearchControl(uq: Lite<UserQueryEntity>): void {
        Navigator.API.fetch(uq).then(userQuery => {
            const sc = p.searchControl;
            UserQueriesClient.Converter.applyUserQuery(sc.props.findOptions, userQuery, sc.props.extraOptions?.entity, sc.props.defaultIncudeDefaultFilters)
                .then(nfo => {
                    sc.setState({ refreshMode: Enum.toName(RefreshModeEnum, userQuery.refreshMode) });
                    void sc.handleChangeFiltermode(nfo.filterOptions.length == 0 || anyPinned(nfo.filterOptions) ? "Simple" : "Advanced", false, true);
                    setCurrentUserQuery(uq);
                    if (sc.props.findOptions.pagination.mode != "All")
                        sc.doSearchPage1();
                });
        });
    }

    function handleBackToDefault(): void {
        const sc = p.searchControl;
        const ofo = sc.props.findOptions;
        Finder.parseFindOptions({ queryName: ofo.queryKey }, sc.props.queryToken, sc.props.defaultIncudeDefaultFilters)
            .then(nfo => {
                ofo.filterOptions = [...ofo.filterOptions.filter(a => a.frozen), ...nfo.filterOptions];
                ofo.columnOptions = nfo.columnOptions;
                ofo.orderOptions = nfo.orderOptions;
                ofo.groupResults = nfo.groupResults;
                ofo.pagination = nfo.pagination;
                ofo.systemTime = nfo.systemTime;
                if (nfo.filterOptions.length == 0 || anyPinned(nfo.filterOptions))
                    void sc.handleChangeFiltermode("Simple");
                sc.setState({ refreshMode: sc.props.defaultRefreshMode });
                setCurrentUserQuery(undefined);
                if (ofo.pagination.mode != "All")
                    sc.doSearchPage1();
            });
    }

    async function handleEdit(): Promise<void> {
        const userQuery = await Navigator.API.fetch(currentUserQuery!);
        await Navigator.view(userQuery);
        await reloadList();
        if (currentUserQuery && await Navigator.API.exists(currentUserQuery))
            applyUserQueryToSearchControl(currentUserQuery);
        else
            setCurrentUserQuery(undefined);
    }

    async function createUserQuery(): Promise<UserQueryEntity> {
        const sc = p.searchControl;
        const fop = sc.props.findOptions;
        const fo = Finder.toFindOptions(fop, sc.props.queryToken, sc.props.defaultIncudeDefaultFilters);

        const uq = new UserQueryEntity();
        uq.query = await UserQueriesClient.API.queryEntity(fop.queryKey);
        uq.displayName = "";
        uq.groupResults = fop.groupResults;
        uq.filters = filterOptionsParsedToEmbedded(fop.filterOptions);
        uq.includeDefaultFilters = fo.includeDefaultFilters ?? null;
        uq.columnsMode = Enum.toValue(ColumnOptionsModeEnum, fo.columnOptionsMode ?? "Add");
        uq.columns = fop.columnOptions.map(toColumnEmbedded);
        uq.orders = fop.orderOptions.map(toOrderEmbedded);
        uq.paginationMode = fop.pagination?.mode == null ? null : Enum.toValue(PaginationModeEnum, fop.pagination.mode);
        uq.elementsPerPage = (fop.pagination?.elementsPerPage ?? null) as UserQueryEntity["elementsPerPage"];
        uq.systemTime = fop.systemTime ? toSystemTimeEmbedded(fop.systemTime) : null;
        uq.refreshMode = Enum.toValue(RefreshModeEnum, sc.state.refreshMode ?? "Auto");
        uq.customDrilldowns = [];
        return uq;
    }

    function handleCreateUserQuery(): void {
        createUserQuery()
            .then(uq => Navigator.view(uq))
            .then(uq => {
                if (uq?.id != null)
                    reloadList().then(() => applyUserQueryToSearchControl(uq.toLite()));
            });
    }

    // Signum's applyChangesToUserQuery: take the CURRENT saved query and overlay the live search's
    // definition onto it, aligning old↔new filters/columns (StringDistance) so per-row tweaks (a custom
    // column display name, a `[value]` expression) survive where the underlying token is unchanged.
    async function applyChangesToUserQuery(): Promise<UserQueryEntity> {
        const sc = p.searchControl;
        const uqOld = await Navigator.API.fetch(currentUserQuery!);
        const foOld = await UserQueriesClient.Converter.toFindOptions(uqOld, sc.props.extraOptions?.entity);
        const uqNew = await createUserQuery();
        const foNew = Finder.toFindOptions(sc.props.findOptions, sc.props.queryToken, sc.props.defaultIncudeDefaultFilters);
        const sd = new StringDistance();

        uqOld.groupResults = uqNew.groupResults;
        uqOld.includeDefaultFilters = uqNew.includeDefaultFilters;
        uqOld.filters = UserQueryMerger.mergeFilters(uqOld.filters, uqNew.filters, notNull(foOld.filterOptions), notNull(foNew.filterOptions), 0, sd);
        uqOld.columns = UserQueryMerger.mergeColumns(uqOld.columns, uqNew.columns, sd);
        uqOld.columnsMode = uqNew.columnsMode;
        uqOld.orders = uqNew.orders;
        uqOld.paginationMode = uqNew.paginationMode;
        uqOld.elementsPerPage = uqNew.elementsPerPage;
        uqOld.systemTime = uqNew.systemTime; // (Signum preserves similar start/end dates — simplified here)
        uqOld.customDrilldowns = uqNew.customDrilldowns;
        return uqOld;
    }

    async function handleApplyChanges(): Promise<void> {
        const uqOld = await applyChangesToUserQuery();
        await Navigator.view(uqOld);
        await reloadList();
        if (currentUserQuery && await Navigator.API.exists(currentUserQuery))
            applyUserQueryToSearchControl(currentUserQuery);
        else
            setCurrentUserQuery(undefined);
    }

    const currentToStr = currentUserQuery ? currentUserQuery.toString() : undefined;
    const large = p.searchControl.props.largeToolbarButtons == true;

    return (
        <Dropdown onToggle={handleToggle} show={isOpen}>
            <Dropdown.Toggle id="userQueriesDropDown" variant="tertiary">
                <span title={currentToStr}>
                    <FontAwesomeIcon icon="rectangle-list" />
                    {large && <>&nbsp;<span className="d-none d-sm-inline">
                        {currentToStr ? <strong>{currentToStr}</strong> : UserQueryEntity.nicePluralName()}
                    </span></>}
                </span>
            </Dropdown.Toggle>
            <Dropdown.Menu>
                <div style={{ maxHeight: "300px", overflowX: "auto" }}>
                    {userQueries?.map((uq, i) =>
                        <Dropdown.Item key={i} active={currentUserQuery != null && uq.key() === currentUserQuery.key()} onClick={() => applyUserQueryToSearchControl(uq)}>
                            {uq.toString()}
                        </Dropdown.Item>)}
                </div>
                {userQueries && userQueries.length > 0 && <Dropdown.Divider />}
                {p.searchControl.props.allowChangeColumns &&
                    <Dropdown.Item onClick={handleBackToDefault}>
                        <FontAwesomeIcon icon="arrow-rotate-left" className="me-2" />{UserQueryMessage.BackToDefault.niceToString()}
                    </Dropdown.Item>}
                {currentUserQuery &&
                    <Dropdown.Item onClick={handleApplyChanges}>
                        <FontAwesomeIcon icon="share-from-square" className="me-2" />{UserQueryMessage.ApplyChanges.niceToString()}
                    </Dropdown.Item>}
                {currentUserQuery &&
                    <Dropdown.Item onClick={handleEdit}>
                        <FontAwesomeIcon icon="pen-to-square" className="me-2" />{UserQueryMessage.Edit.niceToString()}
                    </Dropdown.Item>}
                <Dropdown.Item onClick={handleCreateUserQuery}>
                    <FontAwesomeIcon icon="plus" className="me-2" />{UserQueryMessage.CreateNew.niceToString()}
                </Dropdown.Item>
            </Dropdown.Menu>
        </Dropdown>
    );
}

function anyPinned(filterOptions?: FilterOptionParsed[]): boolean {
    if (filterOptions == null)
        return false;
    return filterOptions.some(a => Boolean(a.pinned) || (isFilterGroup(a) && anyPinned(a.filters)));
}

function notNull<T>(list: (T | null | undefined)[] | undefined): T[] {
    return (list ?? []).filter((a): a is T => a != null);
}

function groupWhen<T>(list: T[], isGroupStart: (t: T) => boolean): T[][] {
    const result: T[][] = [];
    let current: T[] | null = null;
    for (const item of list) {
        if (isGroupStart(item)) { current = [item]; result.push(current); }
        else if (current != null) current.push(item);
    }
    return result;
}

// Port of Signum's UserQueryMerger (UserQueryMenu.tsx). Aligns the OLD stored definition with the NEW one
// from the live search using StringDistance, so matched rows keep their identity (and, for columns, a
// user's custom display name / for filters, a `[…]`-expression value) when the underlying token is the
// same. altea divergence: plain `QueryXEmbedded[]` (no MList/MListElement wrapper; the head row IS the
// element), and no `translated()` — display names compare directly.
export namespace UserQueryMerger {

    export function mergeColumns(oldCols: UserQueryEntity_Columns[], newCols: UserQueryEntity_Columns[], sd: StringDistance): UserQueryEntity_Columns[] {
        const choices = sd.levenshteinChoices(oldCols, newCols,
            c => c.added == null ? 5 : c.removed == null ? 5 : distanceColumns(c.added, c.removed));

        return choices.flatMap(ch => {
            if (ch.added == null) return [];          // removed
            if (ch.removed == null) return [ch.added]; // new
            const oldCol = ch.removed;
            const newCol = ch.added;
            oldCol.token = newCol.token;
            oldCol.displayName = (newCol.displayName == oldCol.displayName ? oldCol.displayName : newCol.displayName) ?? null;
            oldCol.summaryToken = newCol.summaryToken;
            oldCol.combineRows = newCol.combineRows;
            oldCol.hiddenColumn = newCol.hiddenColumn;
            return [oldCol]; // preserve identity
        });
    }

    export function mergeFilters(
        oldFilters: UserQueryEntity_Filters[], newFilters: UserQueryEntity_Filters[],
        oldFilterOptions: FilterOption[], newFilterOptions: FilterOption[],
        indent: number, sd: StringDistance,
    ): UserQueryEntity_Filters[] {
        const oldGroups = groupWhen(oldFilters, a => (a.indentation as unknown as number) == indent);
        const newGroups = groupWhen(newFilters, a => (a.indentation as unknown as number) == indent);

        if (oldGroups.length != oldFilterOptions.length || newGroups.length != newFilterOptions.length)
            throw new Error("Unexpected filter lengths");

        const oldPairs = oldGroups.map((g, i) => ({ head: g[0], elements: g.slice(1), filter: oldFilterOptions[i] }));
        const newPairs = newGroups.map((g, i) => ({ head: g[0], elements: g.slice(1), filter: newFilterOptions[i] }));

        const choices = sd.levenshteinChoices(oldPairs, newPairs,
            c => c.added == null ? 5 : c.removed == null ? 5 : distanceFilter(c.added.filter, c.removed.filter));

        return choices.flatMap(ch => {
            if (ch.added == null) return [];
            if (ch.removed == null) return [ch.added.head, ...ch.added.elements];

            const merged = mergeFilters(
                ch.removed.elements, ch.added.elements,
                isFilterGroup(ch.removed.filter) ? notNull(ch.removed.filter.filters) : [],
                isFilterGroup(ch.added.filter) ? notNull(ch.added.filter.filters) : [],
                indent + 1, sd);

            const oldF = ch.removed.head;
            const newF = ch.added.head;
            oldF.token = newF.token;
            oldF.isGroup = newF.isGroup;
            oldF.groupOperation = newF.groupOperation;
            oldF.operation = newF.operation;
            oldF.valueString = (similarValues(ch.added.filter.value, ch.removed.filter.value)
                || (oldF.valueString?.startsWith("[") && oldF.valueString.endsWith("]"))) ? oldF.valueString : newF.valueString;
            if (newF.pinned == null) {
                oldF.pinned = null;
            } else {
                oldF.pinned ??= new PinnedQueryFilterEmbedded();
                oldF.pinned.label = newF.pinned.label;
                oldF.pinned.column = newF.pinned.column;
                oldF.pinned.row = newF.pinned.row;
                oldF.pinned.active = newF.pinned.active;
                oldF.pinned.splitValue = newF.pinned.splitValue;
            }
            return [oldF, ...merged]; // preserve identity
        });
    }

    export function similarValues(val1: unknown, val2: unknown): boolean {
        if (val1 == val2)
            return true;
        const d1 = Date.parse(String(val1));
        const d2 = Date.parse(String(val2));
        return !isNaN(d1) && !isNaN(d2) && Math.abs(d1 - d2) < 2 * 60 * 60 * 1000; // within 2 hours
    }

    function distanceColumns(qc1: UserQueryEntity_Columns, qc2: UserQueryEntity_Columns): number {
        return (qc1.token?.tokenString == qc2.token?.tokenString ? 0 : 3)
            + (qc1.summaryToken?.tokenString == qc2.summaryToken?.tokenString ? 0 : 1)
            + (qc1.combineRows == qc2.combineRows ? 0 : 1)
            + (qc1.displayName == qc2.displayName ? 0 : 1)
            + (qc1.hiddenColumn == qc2.hiddenColumn ? 0 : 1);
    }

    function distanceFilter(fo: FilterOption, fo2: FilterOption): number {
        if (isFilterGroup(fo)) {
            if (!isFilterGroup(fo2))
                return 10;
            const a = notNull(fo.filters);
            const b = notNull(fo2.filters);
            let sub = 0;
            for (let i = 0; i < Math.max(a.length, b.length); i++)
                sub += a[i] == null ? 5 : b[i] == null ? 5 : distanceFilter(a[i], b[i]);
            return (String(fo.token ?? "") == String(fo2.token ?? "") ? 0 : 1)
                + (fo.groupOperation == fo2.groupOperation ? 0 : 1)
                + (similarValues(fo.value, fo2.value) ? 0 : 1)
                + distancePinned(fo.pinned, fo2.pinned) + sub;
        }
        if (isFilterGroup(fo2))
            return 10;
        return (String(fo.token ?? "") == String(fo2.token ?? "") ? 0 : 1)
            + (fo.operation == fo2.operation ? 0 : 1)
            + (fo.value == fo2.value ? 0 : 1)
            + distancePinned(fo.pinned, fo2.pinned);
    }

    function distancePinned(pin: PinnedFilter | undefined, pin2: PinnedFilter | undefined): number {
        if (pin == null && pin2 == null) return 0;
        if (pin == null || pin2 == null) return 4;
        return (pin.active == pin2.active ? 0 : 1)
            + (pin.column == pin2.column ? 0 : 1)
            + (pin.row == pin2.row ? 0 : 1)
            + (pin.label == pin2.label ? 0 : 1)
            + (pin.splitValue == pin2.splitValue ? 0 : 1);
    }
}

function tokenEmbedded(token: { fullKey(): string }): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = token.fullKey();
    t.token = token as QueryTokenEmbedded["token"];
    return t;
}

function toColumnEmbedded(c: ColumnOptionParsed): UserQueryEntity_Columns {
    const col = new UserQueryEntity_Columns();
    col.token = tokenEmbedded(c.token!);
    col.displayName = (c.displayName as string | undefined) ?? null;
    col.summaryToken = c.summaryToken ? tokenEmbedded(c.summaryToken) : null;
    col.hiddenColumn = c.hiddenColumn ?? false;
    // FindOptions carries member-name strings; the entity enum fields are int-FK ordinals (Enum.toValue).
    col.combineRows = c.combineRows == null ? null : Enum.toValue(CombineRowsEnum, c.combineRows);
    return col;
}

function toOrderEmbedded(o: OrderOptionParsed): UserQueryEntity_Orders {
    const ord = new UserQueryEntity_Orders();
    ord.token = tokenEmbedded(o.token);
    ord.orderType = Enum.toValue(OrderTypeEnum, o.orderType);
    return ord;
}

function toSystemTimeEmbedded(st: SystemTime): SystemTimeEmbedded {
    const e = new SystemTimeEmbedded();
    e.mode = Enum.toValue(SystemTimeModeEnum, st.mode);
    e.startDate = st.startDate == null ? null : Temporal.PlainDateTime.from(st.startDate);
    e.endDate = st.endDate == null ? null : Temporal.PlainDateTime.from(st.endDate);
    e.joinMode = st.joinMode == null ? null : Enum.toValue(SystemTimeJoinModeEnum, st.joinMode);
    e.timeSeriesUnit = st.timeSeriesUnit == null ? null : Enum.toValue(TimeSeriesUnitEnum, st.timeSeriesUnit);
    e.timeSeriesStep = (st.timeSeriesStep ?? null) as SystemTimeEmbedded["timeSeriesStep"];
    e.timeSeriesMaxRowsPerStep = (st.timeSeriesMaxRowsPerStep ?? null) as SystemTimeEmbedded["timeSeriesMaxRowsPerStep"];
    e.splitQueries = st.splitQueries ?? false;
    return e;
}
