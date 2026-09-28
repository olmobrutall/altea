import * as React from "react";
import type { RouteObject } from "react-router";
import { ajaxPost, ajaxPostRaw, saveFile } from "@altea/altea/client/Services";
import type { Type, Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { UserAssetMessage, UserAssetPermission, UserAssetPreviewModel, type IUserAssetEntity } from "../data/UserAssets";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import * as AppContext from "@altea/altea/client/AppContext";
import { Finder } from "@altea/altea/client/Finder";
import type { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import {
    type FilterOptionParsed, type FilterConditionOptionParsed, type FilterGroupOptionParsed, type PinnedFilterParsed,
    isFilterGroup, isList, isPair,
} from "@altea/altea/client/FindOptions";
import { Enum } from "@altea/altea/data/enum";
import "@altea/altea/data/globals/arrayExtensions"; // groupWhen()
import { FilterOperation, FilterGroupOperation, DashboardBehaviour, PinnedFilterActive } from "@altea/altea/data/dynamicQueries";
import { CurrentUserConverter } from "../data/FilterValueConverters/CurrentUserConverter";
import { CurrentEntityConverter } from "../data/FilterValueConverters/CurrentEntityConverter";
import { parseFilterValue, stringifyFilterValue, isFilterValueExpression } from "../data/FilterValueString";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded, QueryFilterBaseEntity, QueryFilterPinnedBaseEntity } from "../data/Queries";

// The export / import trigger surface: the XML export quick-link, the import route, the
// "!ImportUserAssets" omnibox entry and the export/import HTTP API — and the stored-filter conversion every
// user asset shares (`parseFilters` / `stringifyFilters`).

export namespace UserAssetClient {
    let started = false;

    export function start(routes: RouteObject[]): void {
        if (started)
            return;
        started = true;
        // The client holds the whole logged-in user, so "[CurrentUser].Member" paths resolve here.
        CurrentUserConverter.getCurrentUserEntity = () => AppContext.currentUser;

        routes.push({ path: "/userAssets/import", element: <ImportComponent onImport={() => import("./ImportAssetsPage")} /> });

        registerSpecialAction({
            key: "ImportUserAssets",
            allowed: () => AuthClient.isPermissionAuthorized(UserAssetPermission.UserAssetsToXML),
            onClick: () => Promise.resolve("/userAssets/import"),
        });
    }

    // Registers the "Export to XML" quick-link on a user-asset type.
    export function registerExportAssertLink(type: Type<Entity>): void {
        QuickLinkClient.registerQuickLink(type, new QuickLinkAction(
            "ExportToXml",
            () => UserAssetMessage.ExportToXml.niceToString(),
            ctx => API.exportAsset(ctx.lites),
            { allowsMultiple: true, icon: "file-code", iconColor: "#FCAE25" },
        ));
    }

    /**
     * The stored, indentation-tagged filter rows of a user asset (a user query's, a user chart's, a
     * template's…) as the parsed filter tree a SearchControl / chart runs — Signum's
     * `UserAssetClient.API.parseFilters`, the ONE place a stored filter becomes a live one.
     *
     * altea resolves tokens on the client, so this is local rather than Signum's server round-trip. Every
     * value goes through the FilterValueConverter list (FilterValueString), with `entity` as what
     * "[CurrentEntity]" means — Signum's `CurrentEntityConverter.SetCurrentEntity` around the same parse.
     *
     * `keepExpressions` is for an EDITOR of the rows (Signum's FilterBuilderEmbedded binds the raw
     * `valueString`): an expression stays the text the user typed instead of being resolved.
     */
    export async function parseFilters(
        rootToken: QueryToken, rows: readonly QueryFilterBaseEntity[], subTokenOptions: SubTokensOptions,
        options?: { entity?: Lite<Entity>; keepExpressions?: boolean },
    ): Promise<FilterOptionParsed[]> {
        const parse: typeof parseFilterValue = (str, ...rest) =>
            options?.keepExpressions && isFilterValueExpression(str) ? str : parseFilterValue(str, ...rest);

        const completer = new Finder.TokenCompleter(rootToken);
        for (const r of rows)
            if (r.token?.tokenString)
                completer.request(r.token.tokenString);
        await completer.finished();

        function build(filters: QueryFilterBaseEntity[], indent: number): FilterOptionParsed[] {
            return filters.groupWhen(f => f.indentation === indent, false, "skip").map(({ key: head, elements: children }) => {
                const token = head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined;
                if (!head.isGroup) {
                    const operation = head.operation == null ? "EqualTo" : Enum.toName(FilterOperation, head.operation);
                    return {
                        token,
                        operation,
                        value: parse(head.valueString, token?.filterType, token?.type.typeName,
                            { isList: isList(operation), isPair: isPair(operation) }),
                        frozen: false,
                        ...pinnedParsed(head),
                    } as FilterConditionOptionParsed;
                }
                return {
                    token,
                    groupOperation: Enum.toName(FilterGroupOperation, head.groupOperation!),
                    filters: build(children, indent + 1),
                    // A group's value is the free text its pinned search box filters by, so no FilterType.
                    value: parse(head.valueString, undefined),
                    frozen: false,
                    ...pinnedParsed(head),
                } as FilterGroupOptionParsed;
            });
        }

        // Synchronous from here, which is what lets the ambient current entity scope it on the browser.
        return CurrentEntityConverter.withCurrentEntity(options?.entity, () => build([...rows], 0));
    }

    /**
     * A parsed filter tree back to the stored rows of `rowConstructor` (the OWNER's own `@part` row type) —
     * Signum's `UserAssetClient.API.stringifyFilters`, the inverse of {@link parseFilters}.
     */
    export function stringifyFilters<R extends QueryFilterBaseEntity>(filters: FilterOptionParsed[], rowConstructor: new () => R): R[] {
        const rows: R[] = [];
        function push(fo: FilterOptionParsed, indent: number): void {
            const row = new rowConstructor();
            row.indentation = indent as QueryFilterBaseEntity["indentation"];
            // An owner that cannot pin (a predictor's training population) has neither member, and a parsed
            // filter for it never carries either — its editor does not offer them.
            if (row instanceof QueryFilterPinnedBaseEntity) {
                row.pinned = fo.pinned ? toPinnedEmbedded(fo.pinned) : null;
                // FindOptions carries member-name strings; the embedded enum fields are int-FK ordinals.
                row.dashboardBehaviour = fo.dashboardBehaviour == null ? null : Enum.toValue(DashboardBehaviour, fo.dashboardBehaviour);
            }
            row.token = fo.token ? QueryTokenEmbedded.create({ tokenString: fo.token.fullKey(), token: fo.token }) : null;
            if (isFilterGroup(fo)) {
                row.isGroup = true;
                row.groupOperation = fo.groupOperation == null ? null : Enum.toValue(FilterGroupOperation, fo.groupOperation);
                row.valueString = stringifyFilterValue(fo.value, undefined);
                rows.push(row);
                fo.filters.forEach(f => push(f, indent + 1));
            } else {
                row.operation = fo.operation == null ? null : Enum.toValue(FilterOperation, fo.operation);
                row.valueString = stringifyFilterValue(fo.value, fo.token?.filterType, fo.token?.type.typeName);
                rows.push(row);
            }
        }
        filters.forEach(fo => push(fo, 0));
        return rows;
    }

    export namespace API {
        export function exportAsset(lites: Lite<Entity>[]): void {
            ajaxPostRaw({ url: "/api/userAssets/export" }, lites).then(resp => saveFile(resp));
        }

        export interface FileUpload { fileName: string; content: string; }

        export function importPreview(request: FileUpload): Promise<UserAssetPreviewModel> {
            return ajaxPost({ url: "/api/userAssets/importPreview" }, request);
        }

        export interface FileUploadWithModel { file: FileUpload; model: UserAssetPreviewModel; }

        export function importAssets(request: FileUploadWithModel): Promise<void> {
            return ajaxPost({ url: "/api/userAssets/import" }, request);
        }
    }
}

/** The PINNED half of a stored row, for an owner that has one (see QueryFilterPinnedBaseEntity). */
function pinnedParsed(row: QueryFilterBaseEntity): Pick<FilterConditionOptionParsed, "pinned" | "dashboardBehaviour"> {
    if (!(row instanceof QueryFilterPinnedBaseEntity))
        return {};

    return {
        pinned: row.pinned ? toPinnedParsed(row.pinned) : undefined,
        dashboardBehaviour: row.dashboardBehaviour == null ? undefined : Enum.toName(DashboardBehaviour, row.dashboardBehaviour),
    };
}

function toPinnedParsed(p: PinnedQueryFilterEmbedded): PinnedFilterParsed {
    return {
        label: p.label || undefined,
        column: p.column ?? undefined,
        colSpan: p.colSpan ?? undefined,
        row: p.row ?? undefined,
        active: Enum.toName(PinnedFilterActive, p.active),
        splitValue: p.splitValue || undefined,
    };
}

function toPinnedEmbedded(p: PinnedFilterParsed): PinnedQueryFilterEmbedded {
    return PinnedQueryFilterEmbedded.create({
        label: p.label ?? null,
        column: (p.column ?? null) as PinnedQueryFilterEmbedded["column"],
        colSpan: (p.colSpan ?? null) as PinnedQueryFilterEmbedded["colSpan"],
        row: (p.row ?? null) as PinnedQueryFilterEmbedded["row"],
        active: Enum.toValue(PinnedFilterActive, p.active ?? "Always"),
        splitValue: p.splitValue ?? false,
    });
}

// so the type import isn't elided (used above as a type only).
export type { IUserAssetEntity };
