import { Entity, type Type, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { FieldInfo } from "@altea/altea/data/reflection";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/index";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { CollectionElementToken } from "@altea/altea/data/dynamicQuery/tokens/collectionElementToken";
import { CollectionAnyAllToken } from "@altea/altea/data/dynamicQuery/tokens/collectionAnyAllToken";
import { AsTypeToken } from "@altea/altea/data/dynamicQuery/tokens/asTypeToken";
import { HasValueToken } from "@altea/altea/data/dynamicQuery/tokens/hasValueToken";
import { EntityPropertyToken } from "@altea/altea/data/dynamicQuery/tokens/entityPropertyToken";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    QueryRequest, Column, FilterCondition, FilterOperation, Pagination, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Operations } from "@altea/altea/server/operationLogic";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import type { OperationSymbol } from "@altea/altea/data/operations";
import { PropertyAllowed } from "@altea/altea-auth/data/Rules";
import { PropertyAuthLogic } from "@altea/altea-auth/server/PropertyAuthLogic";
import { ImportExcelMode, ImportFromExcelMessage, type ImportExcelModel } from "../../data/Excel";
import { readSheet, cellReference, fromExcelDate, fromExcelNumber, fromExcelTime, type ExcelRow } from "./ExcelReader.server";

// Port of Signum.Excel's ImporterFromExcel.cs — read an .xlsx back into entities: the query's COLUMNS say
// which property each sheet column assigns, its FILTERS supply constant values, and one operation saves
// each resulting entity.
//
// The port keeps Signum's whole shape (ParseQueryRequest → the per-row loop → ImportResult per row) and its
// error messages. Four things diverge, all forced by altea's model:
//
//  1. NO COMPILED SETTERS. Signum built the getter/setter of every column with
//     `PropertyRoute.GetLambdaExpression(...).Compile()`. An altea entity is a plain object and a property
//     route IS a member path ("shipAddress.country"), so an assignment is a walk over `segments` — no
//     expression trees, and missing embeddeds along the path are simply constructed.
//  2. MLISTS ARE GONE. Signum grouped `MList<embedded>` rows and synchronised them by key. An altea
//     collection is an array of `@part` ROW entities (or of rows whose `@valueField` holds a scalar), so
//     "create an element" is `new RowEntity()` + assign the relative segments, and matching an existing
//     element compares the key column's value read off that row.
//  3. `Administrator.DisableIdentity` has no counterpart: altea's save path writes an explicit PK whenever
//     a NEW entity already carries an id (OVERRIDING SYSTEM VALUE / SET IDENTITY_INSERT are emitted by the
//     insert builder), so `model.identityInsert` only decides whether the Id column MAY be assigned.
//  4. The root type is unambiguous. Signum inspected the QueryDescription's Entity-column implementations
//     and refused a query with several (ThisQueryHasMultipleImplementations0); an altea query's shape is a
//     single reflected type, so that check survives only as the "not an entity query" case.

/** Signum's ImportAction. A string union: the value goes to the client as-is (Signum sent the enum name). */
export type ImportAction = "Inserted" | "Updated" | "NoChanges";

/** Signum's ImportResult — one row's outcome, streamed to the client as it happens. */
export interface ImportResult {
    totalRows: number;
    action: ImportAction;
    rowIndex: number;
    entity?: Lite<Entity> | null;
    error?: string | null;
}

/** Signum's ParsedQueryForImport. */
export interface ParsedQueryForImport {
    mainType: Type<Entity>;
    columns: QueryToken[];
    simpleFilters: Map<QueryToken, unknown>;
    elementTopToken?: QueryToken;
}

export namespace ExcelImporter {

    // ---- parse / validate (Signum's ParseQueryRequest) --------------------------------------------------

    /**
     * Validate that this query request can drive an import, and return what the import needs: the entity
     * type, the normalised columns, the constant values its filters imply, and the top collection element.
     *
     * Called BOTH by the `validateForImport` route (before the user picks a file) and by `importExcel`.
     */
    export async function parseQueryRequest(request: QueryRequest): Promise<ParsedQueryForImport> {
        const mainType = getEntityType(request);

        const simpleFilters = getSimpleFilters(request.filters, mainType);
        const columns = getSimpleColumns(request.columns, mainType);

        // Signum: every assigned property must be writable for the current role. A ROOT route (the row
        // identity / ToString, whose token has no property of its own) is checked at the TYPE level by the
        // save gate instead — Signum's CanBeAllowedFor takes that same branch.
        const authErrors: string[] = [];
        for (const token of [...simpleFilters.keys(), ...columns]) {
            const route = (token instanceof HasValueToken ? token.parent : token)?.getPropertyRoute();
            if (route == undefined || route.propertyRouteType !== PropertyRouteType.FieldOrProperty)
                continue;
            const error = await PropertyAuthLogic.canBeAllowedFor(route.rootType.name, route.propertyString(), PropertyAllowed.Write);
            if (error != null && !authErrors.includes(error))
                authErrors.push(error);
        }
        if (authErrors.length > 0)
            throw new Error(authErrors.join("\n"));

        const result: ParsedQueryForImport = { mainType, columns, simpleFilters };

        const elements = distinctTokens(columns.flatMap(c => ancestors(c)).filter(t => t instanceof CollectionElementToken));
        if (elements.length === 0)
            return result;

        // Signum: only the plain `Element` navigation can be imported (Element2 / Element3 are extra
        // independent iterations of the same collection, which cannot be reconstructed from flat rows).
        const notElement = distinct(elements.map(e => e.key).filter(k => k !== "Element"));
        if (notElement.length > 0)
            throw new Error(ImportFromExcelMessage._0IsNotSupported.niceToString(notElement.join(", ")));

        // The single collection every other collection hangs off (Signum's `top`).
        const top = elements.filter(e => elements.every(e2 => e2.fullKey().startsWith(e.fullKey())));
        if (top.length !== 1)
            throw new Error(ImportFromExcelMessage.UnableToAssignMoreThanOneUnrelatedCollections0
                .niceToString(elements.map(e => e.toString()).join(", ")));

        result.elementTopToken = top[0];
        return result;
    }

    // ---- import (Signum's ImportExcel) -----------------------------------------------------------------

    /**
     * Read the model's file and apply every row, yielding one ImportResult per entity as it is saved.
     *
     * `model.transactional` wraps the WHOLE import in one transaction and holds the results back until it
     * commits (Signum does the same: a failure anywhere must not leave half an import behind, so nothing is
     * reported until the outcome is known).
     */
    export async function* importExcel(request: QueryRequest, model: ImportExcelModel, saveOperation: OperationSymbol): AsyncGenerator<ImportResult> {
        const pq = await parseQueryRequest(request);

        const bytes = model.excelFile.binaryFile;
        if (bytes == null)
            throw new Error(ImportFromExcelMessage.ImportFromExcel.niceToString() + ": the model carries no file");

        const rows = readSheet(bytes);

        // Signum's header check: the sheet's second row must name the query's columns, in order.
        const headerRow = rows[1];
        const excelColumns = headerRow == undefined ? [] : takeWhileText(headerRow);
        const queryColumns = request.columns.filter(c => !c.token.isEntity()).map(c => c.displayName ?? c.token.niceName());
        if (excelColumns.join(", ") !== queryColumns.join(", "))
            throw new Error(ImportFromExcelMessage.ColumnsDoNotMatchExcelColumns0QueryColumns1
                .niceToString(excelColumns.join(", "), queryColumns.join(", ")));

        // The data rows: from the third, up to the first fully empty one (Signum's TakeWhile).
        const dataRows: ExcelRow[] = [];
        for (const row of rows.slice(2)) {
            if (![...row.cells.values()].some(v => v != undefined && v !== ""))
                break;
            dataRows.push(row);
        }

        const plan = await buildPlan(pq, model);
        const groups = groupByConsecutive(dataRows, plan.matchBy, plan.matchByIndex);

        const results: ImportResult[] = [];
        let hasErrors = false;

        const runAll = async (): Promise<void> => {
            for (const group of groups) {
                const res: ImportResult = { rowIndex: group.rows[0].rowIndex, totalRows: groups.length, action: "Inserted" };
                try {
                    const entity = await applyGroup(pq, model, plan, group, res);
                    if (entity != null) {
                        const ticksBefore = (entity as unknown as { ticks?: unknown }).ticks;
                        await Operations.execute(entity, saveOperation as ExecuteSymbol<Entity>);
                        if (res.action === "Updated" && ticksBefore === (entity as unknown as { ticks?: unknown }).ticks)
                            res.action = "NoChanges";
                        res.entity = entity.toLite();
                    }
                } catch (e) {
                    hasErrors = true;
                    res.error = (e as Error).message ?? String(e);
                }
                results.push(res);
            }
        };

        if (model.transactional) {
            // One transaction for the lot: rolled back (by rethrowing) unless every row succeeded.
            try {
                await Transaction.create(async () => {
                    await runAll();
                    if (hasErrors)
                        throw new ImportRolledBack();
                });
            } catch (e) {
                if (!(e instanceof ImportRolledBack))
                    throw e;
            }
            for (const res of results)
                yield res;
        } else {
            // Row by row: each save is its own transaction, and each result is reported immediately.
            for (const group of groups) {
                const res: ImportResult = { rowIndex: group.rows[0].rowIndex, totalRows: groups.length, action: "Inserted" };
                try {
                    const entity = await applyGroup(pq, model, plan, group, res);
                    if (entity != null) {
                        const ticksBefore = (entity as unknown as { ticks?: unknown }).ticks;
                        await Operations.execute(entity, saveOperation as ExecuteSymbol<Entity>);
                        if (res.action === "Updated" && ticksBefore === (entity as unknown as { ticks?: unknown }).ticks)
                            res.action = "NoChanges";
                        res.entity = entity.toLite();
                    }
                } catch (e) {
                    res.error = (e as Error).message ?? String(e);
                }
                yield res;
            }
        }
    }
}

/** Thrown to roll a transactional import back; never surfaces to the caller. */
class ImportRolledBack extends Error { }

// ---- the plan -------------------------------------------------------------------------------------------

/** How one query column assigns its value (altea's replacement for Signum's compiled getter/setter pair). */
interface Assignment {
    token: QueryToken;
    colIndex: number;
    /** Member path from the OWNER object (the entity, or a collection element) to the field to write. */
    segments: string[];
    /** Signum's IsId: the row carries the entity's own primary key. */
    isId: boolean;
    /** A non-nullable value field: a null cell is an error rather than a null assignment. */
    required: boolean;
    /** Signum's HasValueToken: `true` materialises the embedded, `false` clears it. */
    isHasValue: boolean;
    /** The collection element this assignment belongs to (undefined ⇒ the entity itself). */
    element?: CollectionElementToken;
    /** Signum's EntityFinder: this column identifies ANOTHER entity, found by querying for it. */
    findBy?: { queryName: unknown; token: QueryToken; wantsEntity: boolean };
}

interface ImportPlan {
    assignments: Assignment[];
    filterAssignments: { assignment: Assignment; value: unknown }[];
    matchBy?: QueryToken;
    matchByIndex?: number;
    /** Per collection element: the collection's member path, the row ctor, and the key column (if any). */
    collections: {
        element: CollectionElementToken;
        segments: string[];
        rowType: Type<Entity>;
        valueField?: FieldInfo;
        key?: { token: QueryToken; colIndex: number };
    }[];
}

async function buildPlan(pq: ParsedQueryForImport, model: ImportExcelModel): Promise<ImportPlan> {
    const queryName = QueryLogic.tryToQueryName(cleanNameOf(pq.mainType)) ?? pq.mainType;
    const token = (s: string): QueryToken => QueryLogic.getToken(queryName, s, SubTokensOptionsAll);

    const assignments = pq.columns.map((t, i) => assignmentFor(t, i, pq.mainType));

    const filterAssignments = [...pq.simpleFilters].map(([t, value]) =>
        ({ assignment: assignmentFor(t, -1, pq.mainType), value }));

    const matchBy = model.matchByColumn == null || model.matchByColumn === "" ? undefined : token(model.matchByColumn);
    const matchByIndex = matchBy == undefined ? undefined
        : pq.columns.findIndex(c => c.fullKey() === matchBy.fullKey());

    if (matchBy != undefined && (matchByIndex == undefined || matchByIndex < 0))
        throw new Error(`The match column '${matchBy.fullKey()}' is not one of the query's columns`);

    const collections = (model.collections ?? []).map(row => {
        const element = pq.columns.flatMap(c => ancestors(c))
            .find((t): t is CollectionElementToken => t instanceof CollectionElementToken && t.fullKey() === row.collectionElement);
        if (element == undefined)
            throw new Error(`The collection '${row.collectionElement}' is not reachable from the query's columns`);

        const route = element.parent!.getPropertyRoute();
        const fieldInfo = route?.fieldInfo;
        const rowType = fieldInfo?.getFunction() as Type<Entity> | undefined;
        if (rowType == undefined)
            throw new Error(`The collection '${row.collectionElement}' does not resolve to a row entity type`);

        const keyIndex = row.matchByColumn == null || row.matchByColumn === "" ? -1
            : pq.columns.findIndex(c => c.fullKey() === row.matchByColumn);

        return {
            element,
            segments: propertyStringOf(element.parent!).split("."),
            rowType,
            valueField: valueFieldOf(rowType),
            key: keyIndex < 0 ? undefined : { token: pq.columns[keyIndex], colIndex: keyIndex },
        };
    });

    return { assignments, filterAssignments, matchBy, matchByIndex, collections };
}

/**
 * The assignment plan for one token: which member path it writes, and — when the token navigates INTO
 * another entity (`customer.contactName`) — the query that FINDS that entity by this value (Signum's
 * EntityFinder).
 */
function assignmentFor(token: QueryToken, colIndex: number, mainType: Type<Entity>): Assignment {
    if (token instanceof HasValueToken) {
        const route = token.parent!.getPropertyRoute()!;
        return {
            token, colIndex, isHasValue: true, isId: false, required: false,
            segments: relativeSegments(route, token),
            element: elementOf(token),
        };
    }

    const route = token.getPropertyRoute();

    // The row IDENTITY. altea models `id` as a sub-token of the ROOT route (it has no field of its own),
    // so it is recognised here rather than by comparing PropertyInfos as Signum did with `piId`.
    if (route == undefined || route.propertyRouteType === PropertyRouteType.Root) {
        if (token.key === "id")
            return { token, colIndex, segments: ["id"], isId: true, required: false, isHasValue: false, element: elementOf(token) };
        throw new Error(ImportFromExcelMessage._01IsIncompatible.niceToString(token.toString(), token.constructor.name));
    }

    // Signum: the first ancestor that is NOT the main type (nor a Part of it) starts a FOREIGN entity; the
    // rest of the path identifies which one, so the value is looked up rather than assigned.
    const chain = ancestors(token).reverse();
    const foreignIndex = chain.findIndex(t => !isMainTypeOrPart(t, mainType));
    let findBy: Assignment["findBy"] | undefined;
    let effectiveRoute = route;

    if (foreignIndex > 0) {
        const first = chain[foreignIndex] instanceof AsTypeToken ? chain[foreignIndex] : chain[foreignIndex - 1];
        const referenceRoute = chain[foreignIndex - 1].getPropertyRoute()!;
        const targetType = referenceRoute.fieldInfo?.getFunction() as Type<Entity> | undefined;
        if (targetType == undefined)
            throw new Error(ImportFromExcelMessage._01IsIncompatible.niceToString(token.toString(), token.constructor.name));

        const relative = token.fullKey().slice(first.fullKey().length + 1);
        const targetQuery = QueryLogic.tryToQueryName(cleanNameOf(targetType)) ?? targetType;
        findBy = {
            queryName: targetQuery,
            token: QueryLogic.getToken(targetQuery, relative, SubTokensOptionsAll),
            wantsEntity: referenceRoute.fieldInfo?.lite !== true,
        };
        effectiveRoute = referenceRoute;
    }

    const fieldInfo = effectiveRoute.fieldInfo;

    return {
        token,
        colIndex,
        segments: relativeSegments(effectiveRoute, token),
        isId: false,
        required: fieldInfo != undefined && fieldInfo.isNullable !== true && fieldInfo.getFunction() == undefined && fieldInfo.array !== true,
        isHasValue: false,
        element: elementOf(token),
        findBy: findBy ?? (fieldInfo?.getFunction() != undefined && fieldInfo.lite !== true
            // A plain reference field that wants the ENTITY (not a Lite): the cell holds a lite key, so the
            // entity has to be retrieved (Signum's `((Lite<Entity>)v).Retrieve()` branch).
            ? { queryName: undefined, token, wantsEntity: true }
            : undefined),
    };
}

/** The member path of `route`, relative to the collection element the token sits under (if any). */
function relativeSegments(route: PropertyRoute, token: QueryToken): string[] {
    const path = propertyStringOf(route);
    const slash = path.lastIndexOf("/");
    const relative = slash < 0 ? path : path.slice(slash + 1);
    void token;
    return relative.split(".").filter(s => s !== "");
}

function propertyStringOf(routeOrToken: PropertyRoute | QueryToken): string {
    const route = routeOrToken instanceof PropertyRoute ? routeOrToken : routeOrToken.getPropertyRoute()!;
    return route.propertyString();
}

/** The innermost collection element among a token's ancestors (Signum's `Follow(a => a.Parent).OfType<…>`). */
function elementOf(token: QueryToken): CollectionElementToken | undefined {
    return ancestors(token).find((t): t is CollectionElementToken => t instanceof CollectionElementToken);
}

// ---- applying one group of rows ------------------------------------------------------------------------

interface RowGroup { key: unknown; rows: ExcelRow[]; }

async function applyGroup(
    pq: ParsedQueryForImport,
    model: ImportExcelModel,
    plan: ImportPlan,
    group: RowGroup,
    res: ImportResult,
): Promise<Entity | null> {
    let entity: Entity | null = null;

    if (plan.matchBy != undefined && group.key != null) {
        entity = await findExisting(pq, plan.matchBy, group.key);
        if (entity != null) {
            res.action = "Updated";
            res.entity = entity.toLite();
        }
    }

    if (entity == null) {
        if (plan.matchBy != undefined && group.key != null
            && model.mode !== ImportExcelMode.Insert && model.mode !== ImportExcelMode.InsertOrUpdate) {
            res.action = "Updated";
            res.error = ImportFromExcelMessage.No0FoundInThisQueryWith1EqualsTo2.niceToString(
                niceNameOf(pq.mainType), plan.matchBy.toString(), String(group.key));
            return null;
        }
        entity = new (pq.mainType as unknown as new () => Entity)();
        res.action = "Inserted";
    } else if (model.mode === ImportExcelMode.Insert) {
        throw new Error(`${niceNameOf(pq.mainType)} already exists (mode is Insert)`);
    }

    // The constant values the query's FILTERS imply — only on a fresh entity (Signum's guard).
    if (res.action === "Inserted")
        for (const { assignment, value } of plan.filterAssignments)
            if (!assignment.isId)
                await assign(entity, assignment, await resolveValue(assignment, value), undefined);

    // The simple (non-collection) columns come off the group's FIRST row.
    const firstRow = group.rows[0];
    for (const assignment of plan.assignments.filter(a => a.element == undefined)) {
        const text = firstRow.cells.get(assignment.colIndex);

        if (assignment.isId) {
            if (text == undefined || text === "")
                continue;
            const id = parseId(text, pq.mainType);
            if (entity.isNew) {
                if (!model.identityInsert)
                    throw new Error(`Unable to set Id because identityInsert is not true. Cell ${cellReference(firstRow, assignment.colIndex)}`);
                entity.id = id;
            } else if (String(entity.id) !== String(id)) {
                throw new Error(`Id does not match. Cell ${cellReference(firstRow, assignment.colIndex)}`);
            }
            continue;
        }

        const value = parseExcelValue(assignment.token, text, firstRow, assignment.colIndex);

        const filterValue = [...pq.simpleFilters].find(([t]) => t.fullKey() === assignment.token.fullKey())?.[1];
        if (filterValue !== undefined && !sameValue(value, filterValue))
            throw new Error(`Value of column ${assignment.token} (${String(value)}) does not match the filter value (${String(filterValue)}). Cell ${cellReference(firstRow, assignment.colIndex)}`);

        await assign(entity, assignment, await resolveValue(assignment, value), firstRow);
    }

    // Collections: one element per row of the group.
    for (const collection of plan.collections) {
        const list = getPath(entity, collection.segments, true) as Entity[] | undefined;
        if (list == undefined || !Array.isArray(list))
            throw new Error(`${collection.element.fullKey()} did not resolve to a collection`);

        const subAssignments = plan.assignments.filter(a => a.element === collection.element && a !== undefined);

        if (collection.key == undefined) {
            // Signum: the last collection of an Insert — the rows simply become the elements.
            if (list.length !== 0)
                throw new Error("The collection should be empty");
            for (const row of group.rows)
                list.push(await buildElement(collection, subAssignments, row, null));
        } else {
            const byKey = new Map<string, Entity>();
            for (const existing of list) {
                const k = keyOfElement(existing, collection, subAssignments);
                if (k != undefined)
                    byKey.set(String(k), existing);
            }

            const seen = new Set<string>();
            for (const row of group.rows) {
                const keyText = row.cells.get(collection.key.colIndex);
                const keyValue = parseExcelValue(collection.key.token, keyText, row, collection.key.colIndex);
                const keyString = String(keyValue instanceof Lite ? keyValue.key() : keyValue);
                seen.add(keyString);

                const existing = byKey.get(keyString);
                if (existing != undefined)
                    await buildElement(collection, subAssignments, row, existing);
                else
                    list.push(await buildElement(collection, subAssignments, row, null));
            }

            // Signum's Synchronizer.removeOld: elements no longer present in the file go away.
            for (const [k, element] of byKey)
                if (!seen.has(k))
                    list.splice(list.indexOf(element), 1);
        }
    }

    return entity;
}

/** Signum's ApplyChanges: fill (or create) one collection element from one sheet row. */
async function buildElement(
    collection: ImportPlan["collections"][number],
    assignments: Assignment[],
    row: ExcelRow,
    existing: Entity | null,
): Promise<Entity> {
    const element = existing ?? new (collection.rowType as unknown as new () => Entity)();

    // A row whose only content is a `@valueField` (altea's non-embedded MList row): the ELEMENT token
    // itself carries the value, so it is written into that field.
    const elementAssignment = assignments.find(a => a.token === (collection.element as QueryToken));
    if (elementAssignment != undefined && collection.valueField != undefined) {
        const text = row.cells.get(elementAssignment.colIndex);
        const value = parseExcelValue(collection.element, text, row, elementAssignment.colIndex);
        (element as unknown as Record<string, unknown>)[collection.valueField.name] = await resolveValue(elementAssignment, value);
        return element;
    }

    for (const assignment of assignments) {
        if (assignment.token === (collection.element as QueryToken))
            continue;
        const text = row.cells.get(assignment.colIndex);
        const value = parseExcelValue(assignment.token, text, row, assignment.colIndex);
        await assign(element, assignment, await resolveValue(assignment, value), row);
    }

    return element;
}

/** The value of a collection element's key column, read off an EXISTING row entity. */
function keyOfElement(element: Entity, collection: ImportPlan["collections"][number], assignments: Assignment[]): unknown {
    const keyAssignment = assignments.find(a => a.colIndex === collection.key?.colIndex);
    if (keyAssignment == undefined)
        return undefined;
    const value = getPath(element, keyAssignment.segments, false);
    return value instanceof Lite ? value.key() : value;
}

// ---- assignment mechanics (Signum's compiled setters) ---------------------------------------------------

/** Walk `segments` and write the last one. Missing embeddeds along the way are constructed. */
async function assign(owner: Entity, assignment: Assignment, value: unknown, row: ExcelRow | undefined): Promise<void> {
    const segments = assignment.segments;
    const last = segments[segments.length - 1];
    const parent = getPath(owner, segments.slice(0, -1), true) as Record<string, unknown> | undefined;

    if (parent == undefined) {
        if (value != null)
            throw new Error(`Unable to assign ${String(value)} (from ${assignment.token}) because the parent is null`);
        return;
    }

    if (assignment.isHasValue) {
        // Signum's HasValue setter: true → keep / create the embedded, false → null it out.
        const route = assignment.token.parent!.getPropertyRoute()!;
        const ctor = route.fieldInfo?.getFunction() as (new () => object) | undefined;
        if (ctor == undefined)
            throw new Error("HasValue is only supported for embedded entities");
        parent[last] = value === true ? (parent[last] ?? new ctor()) : null;
        return;
    }

    if (assignment.required && value == null)
        throw new Error(`Value of column ${assignment.token} is null`
            + (row != undefined ? `. Cell ${cellReference(row, assignment.colIndex)}` : ""));

    parent[last] = value;
}

/** Read (and optionally create) the object `segments` points at. */
function getPath(owner: object, segments: string[], createMissing: boolean): unknown {
    let current: unknown = owner;
    for (const segment of segments) {
        if (current == null)
            return undefined;
        const holder = current as Record<string, unknown>;
        let next = holder[segment];
        if (next == null && createMissing) {
            const ctor = embeddedCtorOf(holder, segment);
            if (ctor != undefined) {
                next = new ctor();
                holder[segment] = next;
            }
        }
        current = next;
    }
    return current;
}

/** The constructor of an embedded field, so a null one can be materialised mid-path. */
function embeddedCtorOf(owner: object, fieldName: string): (new () => object) | undefined {
    const ti = tryGetTypeInfo(owner.constructor);
    const fi = ti?.fields?.[fieldName];
    return fi?.array === true ? (Array as unknown as new () => object) : (fi?.getFunction() as (new () => object) | undefined);
}

/** The `@valueField` of a row entity, if it has one (altea's non-embedded MList row). */
function valueFieldOf(rowType: Type<Entity>): FieldInfo | undefined {
    const ti = tryGetTypeInfo(rowType);
    return ti == undefined ? undefined : Object.values(ti.fields ?? {}).find(f => f.isValueField === true);
}

// ---- values --------------------------------------------------------------------------------------------

/** Signum's ParseExcelValue: the cell's text as the token's own type. */
function parseExcelValue(token: QueryToken, text: string | undefined, row: ExcelRow, colIndex: number): unknown {
    if (text == undefined || text === "")
        return null;

    try {
        switch (token.filterType) {
            case "Lite":
            case "Embedded":
            case "Model":
                return parseOrFindByText(text, token);
            case "Enum": {
                const enumObject = token.type?.getEnum?.();
                if (enumObject == undefined)
                    return text;
                const name = Enum.values(enumObject as Record<string, string | number>)
                    .find(n => n.toLowerCase() === text.trim().toLowerCase());
                return name == undefined ? null : Enum.toValue(enumObject as Record<string, string | number>, name);
            }
            case "Decimal":
                return roundToValidator(fromExcelNumber(text), token);
            case "Integer":
                return Number(fromExcelNumber(text).toFixed(0));
            case "DateTime":
                return fromExcelDate(text, token.type?.typeName !== "PlainDate");
            case "Time":
                return fromExcelTime(text);
            case "Boolean":
                return text === "TRUE" ? true : text === "FALSE" ? false : fromExcelNumber(text).equals(1);
            default:
                return text;
        }
    } catch (e) {
        throw new Error(`Error converting '${text}' to ${token.type?.getTypeName() ?? "?"} in cell ${cellReference(row, colIndex)}:\n${(e as Error).message}`);
    }
}

/** Signum's ParseOrFindByText: a lite KEY parses directly, anything else is matched on ToString. */
function parseOrFindByText(text: string, token: QueryToken): unknown {
    try {
        return Lite.parse(text);
    } catch {
        // Not a key: leave the raw text for `resolveValue`, which knows the query to look it up in.
        return text;
    }
}

/** Signum's EntityFinder / `.Retrieve()`: turn the parsed value into what the FIELD wants. */
async function resolveValue(assignment: Assignment, value: unknown): Promise<unknown> {
    if (value == null || assignment.findBy == undefined)
        return value;

    const { queryName, token, wantsEntity } = assignment.findBy;

    // Already a lite: only a retrieve may be needed.
    if (value instanceof Lite)
        return wantsEntity ? await retrieveOf(value) : value;

    if (queryName == undefined)
        return value;

    const request = new QueryRequest(queryName as never, [new FilterCondition(token, FilterOperation.EqualTo, value)],
        [], [], new Pagination.Firsts(2), false);
    const rt = await QueryLogic.queries.executeQueryAsync(request);

    const found = rt.entityColumn?.values ?? [];
    if (found.length === 0)
        throw new Error(ImportFromExcelMessage.No0FoundInThisQueryWith1EqualsTo2
            .niceToString(String(queryName), token.toString(), String(value)));
    if (found.length > 1)
        throw new Error(`More than one row found with ${token} equals to '${String(value)}'`);

    const lite = found[0] as Lite<Entity>;
    return wantsEntity ? await retrieveOf(lite) : lite;
}

async function retrieveOf(lite: Lite<Entity>): Promise<Entity> {
    const { retrieve } = await import("@altea/altea/server/Database");
    return await retrieve(lite.entityType as Type<Entity>, lite.id);
}

/** Signum's RoundToValidator: honour the property's decimal-places validator. */
function roundToValidator(value: Decimal, token: QueryToken): Decimal {
    const decimals = token.getPropertyRoute()?.fieldInfo?.columnOptions?.scale;
    return decimals == undefined ? value : new Decimal(value.toFixed(decimals));
}

function parseId(text: string, mainType: Type<Entity>): PrimaryKey {
    return (mainType as unknown as { parseId(id: string): PrimaryKey }).parseId(text.trim());
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a instanceof Lite && b instanceof Lite)
        return a.key() === b.key();
    if (a instanceof Decimal && b instanceof Decimal)
        return a.equals(b);
    if (a instanceof Temporal.PlainDate || a instanceof Temporal.PlainDateTime || a instanceof Temporal.PlainTime)
        return a.toString() === String(b);
    return a === b;
}

// ---- grouping (Signum's GroupByConsecutive) ------------------------------------------------------------

/**
 * Rows sharing the same key value, CONSECUTIVELY (Signum's GroupWhenChange): a group is one entity, its
 * rows are that entity's collection elements. The same key reappearing later is an error — the file would
 * describe one entity twice.
 */
function groupByConsecutive(rows: ExcelRow[], matchBy: QueryToken | undefined, matchByIndex: number | undefined): RowGroup[] {
    const groups: RowGroup[] = [];

    for (const row of rows) {
        if (matchBy == undefined || matchByIndex == undefined) {
            groups.push({ key: row.rowIndex, rows: [row] }); // no key ⇒ one entity per row
            continue;
        }
        const text = row.cells.get(matchByIndex);
        const value = parseExcelValue(matchBy, text, row, matchByIndex);
        const key = value instanceof Lite ? value.key() : value;

        const last = groups[groups.length - 1];
        if (last != undefined && sameKey(last.key, key))
            last.rows.push(row);
        else
            groups.push({ key, rows: [row] });
    }

    const seen = new Map<string, RowGroup[]>();
    for (const g of groups) {
        const k = String(g.key);
        const list = seen.get(k) ?? [];
        list.push(g);
        seen.set(k, list);
    }
    const duplicated = [...seen].filter(([, list]) => list.length > 1);
    if (duplicated.length > 0)
        throw new Error(ImportFromExcelMessage.DuplicatedNonConsecutive0Found1.niceToString(
            matchBy?.toString() ?? "",
            duplicated.map(([k, list]) => `${k} in rows ${list.map(g => g.rows[0].rowIndex).join(", ")}`).join("\n")));

    return groups;
}

function sameKey(a: unknown, b: unknown): boolean {
    return a === b || String(a) === String(b);
}

// ---- query-shape validation (Signum's GetSimpleColumns / GetSimpleFilters / IsSimpleProperty) -----------

function getEntityType(request: QueryRequest): Type<Entity> {
    const rootType = request.columns.find(c => c.token.isEntity())?.token.type?.getFunction()
        ?? QueryLogic.getToken(request.queryName, "", SubTokensOptionsAll).type?.getFunction();

    if (rootType == undefined || !(rootType === Entity || rootType.prototype instanceof Entity))
        throw new Error(ImportFromExcelMessage.ThisQueryHasMultipleImplementations0.niceToString(String(request.queryName)));

    return rootType as Type<Entity>;
}

function getSimpleColumns(columns: Column[], mainType: Type<Entity>): QueryToken[] {
    const visible = columns.filter(c => !c.token.isEntity());

    const errors = visible.map(c => isSimpleProperty(c.token, mainType)).filter((e): e is string => e != null);
    if (errors.length > 0)
        throw new Error(ImportFromExcelMessage.SomeColumnsAreIncompatibleWithImportingFromExcel.niceToString()
            + "\n" + distinct(errors).join("\n"));

    const tokens = visible.map(c => c.token);
    const repeated = tokens.filter((t, i) => tokens.findIndex(o => o.fullKey() === t.fullKey()) !== i);
    if (repeated.length > 0)
        throw new Error(distinct(repeated.map(t => `Column '${t}' is repeated`)).join("\n"));

    return tokens;
}

function getSimpleFilters(filters: Filter[], mainType: Type<Entity>): Map<QueryToken, unknown> {
    const result = new Map<QueryToken, unknown>();

    const conditions = filters.filter((f): f is FilterCondition => f instanceof FilterCondition)
        .filter(fc => fc.operation === FilterOperation.EqualTo
            && isSimpleProperty(fc.token, mainType) == null
            && elementOf(fc.token) == undefined);

    for (const fc of conditions) {
        const existing = [...result.keys()].find(t => t.fullKey() === fc.token.fullKey());
        if (existing == undefined) {
            result.set(fc.token, fc.value);
            continue;
        }
        if (!sameValue(result.get(existing), fc.value))
            throw new Error(ImportFromExcelMessage.ManyFiltersTryToAssignTheSameProperty0WithDifferentValues1
                .niceToString(fc.token.toString(), `${String(result.get(existing))}, ${String(fc.value)}`));
    }

    return result;
}

/** Signum's IsSimpleProperty: null when the token can be assigned, else why not. */
function isSimpleProperty(token: QueryToken, mainType: Type<Entity>): string | null {
    if (token.filterType == undefined)
        return ImportFromExcelMessage._0IsNotSupported.niceToString(token.niceTypeName?.() ?? token.toString());

    if (token.filterType === "Embedded") {
        const nullable = token.getPropertyRoute()?.fieldInfo?.isNullable === true;
        return ImportFromExcelMessage._01CanNotBeAssignedDirectylEachNestedFieldShouldBeAssignedIndependently
            .niceToString(token.type?.getTypeName() ?? "", token.toString())
            + (nullable ? " " + ImportFromExcelMessage._01CanAlsoBeUsed.niceToString(token.toString(), "HasValue") : "");
    }

    for (const t of ancestors(token).reverse()) {
        const ok = t.parent == undefined                                 // the query root
            || t instanceof EntityPropertyToken
            || t instanceof CollectionElementToken
            || t instanceof AsTypeToken
            || (t instanceof HasValueToken && t.parent?.filterType === "Embedded");
        if (!ok)
            return ImportFromExcelMessage._01IsIncompatible.niceToString(t.toString(), t.constructor.name);
        if (t instanceof CollectionAnyAllToken)
            return ImportFromExcelMessage._01IsIncompatible.niceToString(t.toString(), t.constructor.name);
    }

    void mainType;
    return null;
}

/** Signum's IsMainTypeOrPart: the token's route belongs to the main type, or to a Part owned by it. */
function isMainTypeOrPart(token: QueryToken, mainType: Type<Entity>): boolean {
    const route = token.getPropertyRoute();
    if (route == undefined)
        return token.parent == undefined; // the query root itself

    if (route.rootType === mainType)
        return true;

    const kind = tryGetTypeInfo(route.rootType)?.entityKind;
    if (kind !== "Part" && kind !== "SharedPart")
        return false;

    return token.parent != undefined && isMainTypeOrPart(token.parent, mainType);
}

// ---- small helpers -------------------------------------------------------------------------------------

/** A token and every ancestor, innermost first (Signum's `Follow(a => a.Parent)`). */
function ancestors(token: QueryToken): QueryToken[] {
    const list: QueryToken[] = [];
    for (let t: QueryToken | undefined = token; t != undefined; t = t.parent)
        list.push(t);
    return list;
}

function distinct(values: string[]): string[] {
    return [...new Set(values)];
}

function distinctTokens(tokens: QueryToken[]): CollectionElementToken[] {
    const byKey = new Map<string, CollectionElementToken>();
    for (const t of tokens)
        if (t instanceof CollectionElementToken)
            byKey.set(t.fullKey(), t);
    return [...byKey.values()];
}

/** The rows of the header that carry text, stopping at the first blank (Signum's TakeWhile). */
function takeWhileText(row: ExcelRow): string[] {
    const out: string[] = [];
    for (let i = 0; ; i++) {
        const text = row.cells.get(i);
        if (text == undefined || text === "")
            return out;
        out.push(text);
    }
}

async function findExisting(pq: ParsedQueryForImport, matchBy: QueryToken, key: unknown): Promise<Entity | null> {
    const request = new QueryRequest(
        QueryLogic.tryToQueryName(cleanNameOf(pq.mainType)) ?? pq.mainType as never,
        [new FilterCondition(matchBy, FilterOperation.EqualTo, key)],
        [], [], new Pagination.Firsts(2), false);

    const rt = await QueryLogic.queries.executeQueryAsync(request);
    const lites = rt.entityColumn?.values ?? [];
    if (lites.length === 0)
        return null;
    if (lites.length > 1)
        throw new Error(`More than one ${niceNameOf(pq.mainType)} found with ${matchBy} equals to '${String(key)}'`);

    return await retrieveOf(lites[0] as Lite<Entity>);
}

function cleanNameOf(type: Type<Entity>): string {
    return cleanTypeName(type);
}

function niceNameOf(type: Type<Entity>): string {
    return (type as unknown as { niceName?: () => string }).niceName?.() ?? cleanNameOf(type);
}
