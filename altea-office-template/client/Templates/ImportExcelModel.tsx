import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EnumLine, type OptionItem } from "@altea/altea/client/Lines/EnumLine";
import { mlistItemContext, type TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Operations } from "@altea/altea/client/Operations";
import { getTypeInfo, type TypeInfo } from "@altea/altea/client/Reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import type { MarkedRow } from "@altea/altea/client/SearchControl/ContextualItems";
import type { FindOptionsParsed } from "@altea/altea/client/FindOptions";
import ErrorModal from "@altea/altea/client/Modals/ErrorModal";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import { softCast } from "@altea/altea/data/globals";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import {
    CollectionElementEmbedded, ImportExcelMode, ImportExcelModel, ImportFromExcelMessage,
} from "../../data/Excel";
import { ExcelClient } from "../ExcelClient";
import { selectPagination } from "../ExcelMenu";

// Port of Signum.Excel's Templates/ImportExcelModel.tsx — the modal that configures an import (which
// operation saves each row, insert/update, which column identifies an existing row) plus the flow around it:
// validate → edit the model → stream the file → mark the rows of the SearchControl that produced it.
//
// altea divergences:
//  - **there is no QueryDescription.** Signum read the imported type off `qd.columns["Entity"].type`; here the
//    query's ROOT token carries it (`Finder.getQueryRoot(...).type.typeInfos()`), and the collection token the
//    server answers with arrives as a STRING that `Finder.parseSingleToken` resolves.
//  - `token.fullKey` / `queryTokenType == "Element"` are METHODS on altea's QueryToken class: `fullKey()` /
//    `isElement()` / `hasElement()`.
//  - `getTypeInfo(t).operations` does not exist — a type's operations live on the runtime metadata blob, read
//    through `Operations.operationInfos(ti)` (see CLAUDE.md, XxxInfo vs XxxMetadata).
//  - an enum FIELD holds its ordinal, so `mode` is compared through the enum members (`ImportExcelMode.Insert`),
//    not Signum's bare `"Insert"` literals — the shape @altea/altea-tree's `InsertPlace` documents.
//  - the per-row `label` is built OUTSIDE the JSX attribute: the quote-transformer does not rewrite a lambda
//    in a JSX attribute, so `ctxe.niceName(a => a.matchByColumn)` has to be evaluated in a statement.
//  - `newMListElement(X.New(...))` → a plain `CollectionElementEmbedded.create(...)` (altea has no MList).

export default function ImportExcel(p: {
    ctx: TypeContext<ImportExcelModel>;
    searchControl: SearchControlLoaded;
    fop: FindOptionsParsed;
    topElementToken: QueryToken | null;
}): React.JSX.Element {

    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();

    const parentTokens = (p.topElementToken?.getTokenParents() ?? []).toObject(a => a.fullKey());

    function handlePlainExcelForImport(): void {
        void selectPagination(p.searchControl).then(req => req && ExcelClient.API.generatePlainExcel(req, undefined, true));
    }

    /** The columns INSIDE one collection element — i.e. below its token, but not below a nested Element. */
    function potentialKeys(elementToken: string) {
        return p.fop.columnOptions.filter(a => a.token != null
            && a.token.fullKey().startsWith(elementToken)
            && !a.token.fullKey().after(elementToken).split(".").includes("Element"));
    }

    const collectionCtxs = mlistItemContext(ctx.subCtx(a => a.collections))
        .filter((_ctxe, i, arr) => ctx.value.mode === ImportExcelMode.Update
            || ctx.value.mode === ImportExcelMode.InsertOrUpdate
            || ctx.value.mode === ImportExcelMode.Insert && i < arr.length - 1);

    return (
        <div>
            <div className="row">
                <div className="col-sm-4">
                    <EnumLine ctx={ctx.subCtx(f => f.operationKey)}
                        optionItems={getSaveOperations(p.ctx.value.typeName, ctx.value.mode)
                            .map(a => softCast<OptionItem>({ value: a.key, label: a.niceName }))}
                    />
                    <CheckboxLine ctx={ctx.subCtx(f => f.transactional)} inlineCheckbox="block" />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx.subCtx(f => f.mode)} onChange={() => {
                        if (ctx.value.mode === ImportExcelMode.Insert && ctx.value.collections.length === 0)
                            ctx.value.matchByColumn = null;
                        else
                            ctx.value.matchByColumn = (ctx.value.matchByColumn
                                ?? p.fop.columnOptions.firstOrNull(a => a.token?.fullKey() === "Id")?.token?.fullKey()) ?? null;

                        const operations = getSaveOperations(p.ctx.value.typeName, ctx.value.mode);
                        if (!operations.some(o => o.key === ctx.value.operationKey))
                            ctx.value.operationKey = null!;

                        if (ctx.value.mode === ImportExcelMode.Update)
                            ctx.value.identityInsert = false;

                        forceUpdate();
                    }} />
                    {(ctx.value.mode === ImportExcelMode.Insert || ctx.value.mode === ImportExcelMode.InsertOrUpdate) &&
                        <CheckboxLine ctx={ctx.subCtx(f => f.identityInsert)} inlineCheckbox="block" />}
                </div>
                <div className="col-sm-4">
                    {(ctx.value.mode === ImportExcelMode.Update || ctx.value.mode === ImportExcelMode.InsertOrUpdate || ctx.value.collections.length > 0) &&
                        <EnumLine ctx={ctx.subCtx(f => f.matchByColumn)} mandatory
                            optionItems={p.fop.columnOptions.filter(a => a.token != null && !a.token.hasElement())
                                .map(c => softCast<OptionItem>({ value: c.token!.fullKey(), label: c.displayName ?? c.token!.niceName() }))}
                        />}
                    {collectionCtxs.map((ctxe, i) => {
                        const label = ctxe.niceName(a => a.matchByColumn) + ": " + parentTokens[ctxe.value.collectionElement].niceName();
                        return (
                            <EnumLine key={i} ctx={ctxe.subCtx(a => a.matchByColumn)} label={label}
                                optionItems={potentialKeys(ctxe.value.collectionElement)
                                    .map(c => softCast<OptionItem>({ value: c.token!.fullKey(), label: c.displayName ?? c.token!.niceName() }))}
                            />
                        );
                    })}
                </div>
            </div>

            <br />

            <FileLine ctx={ctx.subCtx(f => f.excelFile)} />

            <button type="button" className="btn btn-xs btn-info" onClick={handlePlainExcelForImport}>
                <FontAwesomeIcon aria-hidden={true} icon="download" /> {ImportFromExcelMessage.DownloadTemplate.niceToString()}
            </button>
        </div>
    );
}

/** The Execute operations that could SAVE an imported row — Signum's same filter. */
function getSaveOperations(typeName: string, mode: ImportExcelMode | null) {
    return Operations.operationInfos(getTypeInfo(typeName))
        .filter(a => a.operationType === "Execute" && a.canBeModified === true
            && (mode === ImportExcelMode.Update || a.canBeNew === true));
}

/**
 * Signum's `onImportFromExcel`: ask the server whether this query request can drive an import, edit the model,
 * stream the file, then report — retrying the whole thing whenever the model turns out to be wrong.
 */
export async function onImportFromExcel(sc: SearchControlLoaded): Promise<void> {

    const qr = sc.getQueryRequest(true);
    qr.pagination = { mode: "All" };

    const topTokenKey = await ExcelClient.API.validateForImport(qr);
    const topToken = topTokenKey == null ? null
        : await Finder.parseSingleToken(qr.queryKey, topTokenKey, SubTokensOptions.CanElement);

    const root = await Finder.getQueryRoot(qr.queryKey);
    const ti: TypeInfo = root.type.typeInfos().single();

    let model = ImportExcelModel.create({
        typeName: cleanTypeName(ti.ctor!),
        mode: null!,
        operationKey: getSaveOperations(cleanTypeName(ti.ctor!), null).onlyOrNull()?.key!,
        collections: (topToken?.getTokenParents() ?? [])
            .filter(t => t.isElement())
            .map(m => CollectionElementEmbedded.create({ collectionElement: m.fullKey() })),
    });

    await onImportFromExcelRetry();

    async function onImportFromExcelRetry(): Promise<void> {

        model = (await Navigator.view(model, {
            extraProps: { searchControl: sc, fop: sc.state.resultFindOptions, topElementToken: topToken },
            title: ImportFromExcelMessage.Import0FromExcel.niceToString(ti.getNicePluralName()),
        }))!;

        if (model == null)
            return;

        const r = await ExcelClient.API.importFromExcel(qr, model, ti);

        if (r.error) {
            await ErrorModal.showErrorModal(r.error);
            await onImportFromExcelRetry();
            return;
        }

        if (model.transactional) {
            const errors = r.results.filter(a => a.error != null);
            if (errors.length) {
                await MessageModal.showError(
                    <ul>{errors.map((e, i) => <li key={i}><strong>{e.rowIndex}</strong> {e.error}</li>)}</ul>,
                    ImportFromExcelMessage.ErrorsIn0Rows_N.niceToString().forGenderAndNumber(errors.length).formatWith(errors.length));

                await onImportFromExcelRetry();
                return;
            }
        } else {
            // Not transactional: a row that failed BEFORE producing an entity is the only real error — the
            // rest are reported per row on the grid below.
            const errors = r.results.filter(a => a.error != null && a.entity == null);
            if (errors.length) {
                await MessageModal.show({
                    buttons: "ok",
                    icon: "error",
                    style: "error",
                    size: "xl",
                    title: ImportFromExcelMessage.ErrorsIn0Rows_N.niceToString().forGenderAndNumber(errors.length).formatWith(errors.length),
                    message: <ul>{errors.map((e, i) => <li key={i}><strong>Row {e.rowIndex}:</strong> {e.error}</li>)}</ul>,
                });

                if (errors.length === r.results.length) {
                    await onImportFromExcelRetry();
                    return;
                }
            }
        }

        const state = r.results.filter(a => a.entity != null).toObject(a => a.entity!.key(), a => {

            if (a.error)
                return softCast<MarkedRow>({ message: `Error in Row ${a.rowIndex}: ${a.error}`, status: "Error" });

            if (a.action === "Updated")
                return softCast<MarkedRow>({ message: `Updated from Row ${a.rowIndex}`, status: "Warning" });

            if (a.action === "Inserted")
                return softCast<MarkedRow>({ message: `Inserted from Row ${a.rowIndex}`, status: "Success" });

            if (a.action === "NoChanges")
                return softCast<MarkedRow>({ message: `No changes in Row ${a.rowIndex}`, status: "Muted" });

            throw new Error("Unexpected value " + a.action);
        });

        sc.markRows(state);
    }
}
