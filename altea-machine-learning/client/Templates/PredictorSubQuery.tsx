import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { Finder } from "@altea/altea/client/Finder";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import type { ColumnOption, FindOptions } from "@altea/altea/client/FindOptions";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    FilterBuilderEmbedded, toFilterOptionParsed,
} from "@altea/altea-user-queries/client/Templates/FilterBuilderEmbedded";
import {
    PredictorEntity, PredictorMainQueryEmbedded, PredictorMessage, PredictorSubQueryColumnUsage,
    PredictorSubQueryEntity, PredictorSubQueryEntity_Column, PredictorSubQueryEntity_Filter,
} from "../../data/Predictor";
import { initializeColumn } from "./ColumnDefaults";

// Port of Signum.MachineLearning's Templates/PredictorSubQuery.tsx — one sub-query of a predictor.
//
// What a sub-query IS, because the column usages only make sense once that is clear: the main query gives
// the network one row per thing predicted about, and a sub-query FLATTENS a one-to-many into extra input
// slots on that same row. Its ParentKey says which main row a sub-query row belongs to; its SplitBy keys
// say which SLOT it lands in (one per distinct key, fixed at training time); the rest are the values.
// "The last 12 months of sales, one input per month" is a sub-query with a ParentKey of the customer, a
// SplitBy of the month and an Input of the total.
//
// altea divergences, documented inline:
//  - `initializeColumn` lives in ColumnDefaults (Signum imports it back out of Predictor.tsx — a cycle).
//  - the PREVIEW builds its FindOptions client-side. Signum posts the filters to
//    `UserAssetClient.API.parseFilters`, which altea does not have; the same conversion the filter EDITOR
//    already does client-side (`toFilterOptionParsed`) is what the preview needs, so it is exported from
//    there rather than duplicated.
//  - `p.mainQueryDescription` is gone with QueryDescription: the expected type of the FIRST ParentKey is
//    the main query's ROOT token type, resolved through `Finder.getQueryRoot`.

interface PredictorSubQueryProps {
    ctx: TypeContext<PredictorSubQueryEntity>;
    mainQuery: PredictorMainQueryEmbedded;
    /** The main query's root token — what a non-grouped ParentKey must point at. */
    mainQueryRoot: QueryToken | undefined;
}

export default function PredictorSubQuery(p: PredictorSubQueryProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const ctxxs = ctx.subCtx({ formSize: "xs" });
    const entity = ctx.value;
    const queryKey = entity.query?.key;

    const parentCtx = ctx.findParentCtx(PredictorEntity);
    const predictor = parentCtx.value;
    const mq = predictor.mainQuery;

    // The sub-query's own root, for resolving its stored tokens in the preview.
    const subQueryRoot = useAPI(
        () => queryKey == null ? Promise.resolve(undefined) : Finder.getQueryRoot(queryKey),
        [queryKey]);

    function handleQueryChange(): void {
        // Filters and columns are written against the OLD query's tokens; keeping them would leave rows
        // whose tokens cannot resolve. Signum's same clear.
        entity.filters = [];
        entity.columns = [];
        forceUpdate();
    }

    /**
     * Signum's `handleChangeUsage` — only Input and Output columns are ENCODED, so the encoding pair is
     * filled in when a column becomes one and cleared when it stops being one (a ParentKey / SplitBy with
     * an encoding fails validation).
     */
    function handleChangeUsage(colCtx: TypeContext<PredictorSubQueryEntity_Column>): void {
        const col = colCtx.value;
        if (isInputOutput(col.usage))
            initializeColumn(col, col.token?.token);
        else {
            col.encoding = null;
            col.nullHandling = null;
        }
        forceUpdate();
    }

    /**
     * Signum's `getMainFilters` — the main query's filters, REBASED onto this sub-query.
     *
     * The point of the preview is to show the rows the training will actually see, and the training reads
     * a sub-query narrowed to the main query's population. When the two queries are the same, the filters
     * apply as they are; otherwise they are prefixed with the ParentKey's own path, which is the route
     * from a sub-query row back to its main row.
     */
    function mainFiltersRebased(): PredictorSubQueryEntity_Filter[] | null {
        if (mq.query?.is(entity.query))
            return predictor.filters as unknown as PredictorSubQueryEntity_Filter[];

        const parentKeys = entity.columns.filter(c => c.usage === PredictorSubQueryColumnUsage.ParentKey);
        const prefix = parentKeys.length === 1 ? parentKeys[0]!.token?.tokenString : undefined;
        if (prefix == null)
            return null;

        return predictor.filters.map(f => {
            const row = new PredictorSubQueryEntity_Filter();
            row.token = f.token == null ? null : Object.assign(new QueryTokenEmbedded(), {
                tokenString: `${prefix}.${f.token.tokenString}`,
            });
            row.operation = f.operation;
            row.valueString = f.valueString;
            row.indentation = f.indentation;
            row.isGroup = f.isGroup;
            row.groupOperation = f.groupOperation;
            return row;
        });
    }

    async function handlePreviewSubQuery(e: React.MouseEvent<HTMLElement>): Promise<void> {
        if (queryKey == null || subQueryRoot == null)
            return;

        const allFilters = [...(mainFiltersRebased() ?? []), ...entity.filters];
        const options = SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate;
        const parsed = await toFilterOptionParsed(subQueryRoot, allFilters, options);

        // GROUPED, as the training reads it: one row per (ParentKey, SplitBy…), which is what makes the
        // preview show the slots rather than the raw rows.
        const fo: FindOptions = {
            queryName: queryKey,
            groupResults: true,
            filterOptions: Finder.toFilterOptions(parsed),
            columnOptions: [
                { token: "Count" } as ColumnOption,
                ...entity.columns.map(c => ({ token: c.token?.tokenString } as ColumnOption)),
            ],
            columnOptionsMode: "ReplaceAll",
        };

        Finder.exploreWindowsOpen(fo, e);
    }

    /**
     * Signum's `getParentKeyMessage` — which type each ParentKey is expected to be.
     *
     * The order matters and is easy to get wrong: with a GROUPED main query there is one ParentKey per
     * non-aggregate main column, matched positionally, so the help text names the type the Nth one must
     * have. Without grouping there is exactly one, the main query's entity.
     */
    const expectedTypes: string[] = mq.groupResults
        ? predictor.columns
            .map(c => c.token?.token)
            .filter((t): t is QueryToken => t != null && !t.isAggregate())
            .map(t => t.niceTypeName())
        : [p.mainQueryRoot?.niceTypeName() ?? ""];

    const parentKeyColumns = entity.columns.filter(c => c.usage === PredictorSubQueryColumnUsage.ParentKey);

    function parentKeyMessage(col: PredictorSubQueryEntity_Column): string | undefined {
        const index = parentKeyColumns.indexOf(col);
        if (index === -1)
            return undefined;
        return index < expectedTypes.length
            ? PredictorMessage.ShouldBeOfType0.niceToString(expectedTypes[index]!)
            : PredictorMessage.TooManyParentKeys.niceToString();
    }

    return (
        <div>
            {/* The name is the TAB's title in the designer, so a rename must repaint the parent. */}
            <TextBoxLine ctx={ctx.subCtx(f => f.name)}
                valueHtmlAttributes={{ onBlur: () => parentCtx.frame?.entityComponent?.forceUpdate() }} />
            <EntityLine ctx={ctx.subCtx(f => f.query)} remove={ctx.value.isNew} onChange={handleQueryChange} />
            {queryKey && <div>
                <FilterBuilderEmbedded ctx={ctxxs.subCtx(a => a.filters)} queryKey={queryKey}
                    subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate} />
                <EntityTable ctx={ctxxs.subCtx(e => e.columns)} columns={[
                    {
                        property: a => a.usage,
                        template: colCtx =>
                            <AutoLine ctx={colCtx.subCtx(a => a.usage)} onChange={() => handleChangeUsage(colCtx)} />,
                    },
                    {
                        property: a => a.token,
                        template: (colCtx, row) => <QueryTokenEmbeddedBuilder
                            ctx={colCtx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                            queryKey={queryKey}
                            subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanAggregate}
                            onTokenChanged={() => { handleChangeUsage(colCtx); row.forceUpdate(); }}
                            helpText={parentKeyMessage(colCtx.value)} />,
                        headerHtmlAttributes: { style: { width: "50%" } },
                    },
                    {
                        property: a => a.encoding,
                        template: colCtx => isInputOutput(colCtx.value.usage)
                            ? <AutoLine ctx={colCtx.subCtx(a => a.encoding)} /> : undefined,
                    },
                    {
                        property: a => a.nullHandling,
                        template: colCtx => isInputOutput(colCtx.value.usage)
                            ? <AutoLine ctx={colCtx.subCtx(a => a.nullHandling)} /> : undefined,
                    },
                ]} />

                <LinkButton title={undefined} onClick={e => void handlePreviewSubQuery(e)}>
                    {PredictorMessage.Preview.niceToString()}
                </LinkButton>
            </div>}
        </div>
    );
}

function isInputOutput(usage: PredictorSubQueryColumnUsage | undefined | null): boolean {
    return usage === PredictorSubQueryColumnUsage.Input || usage === PredictorSubQueryColumnUsage.Output;
}

