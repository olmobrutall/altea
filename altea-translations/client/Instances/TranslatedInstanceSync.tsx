import * as React from "react";
import { Link, useLocation, useParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Operations } from "@altea/altea/client/Operations";
import { AccessibleRow, AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import TextArea from "@altea/altea/client/Components/TextArea";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { useAPIWithReload, useForceUpdate, useLock } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Dic } from "@altea/altea/data/globals";
import { DiffDocumentSimple } from "@altea/altea-diff-log/client/Templates/DiffDocument";
import "@altea/altea-diff-log/client/Templates/DiffLog.css";
import { TranslationMessage } from "../../data/Translation";
import { TranslatedInstanceClient } from "../TranslatedInstanceClient";
import { TranslatedHtmlEditor, TranslatedHtmlViewer } from "./TranslatedHtml";
import { initialElementIf, onEscapeToText } from "../Code/TranslationTypeTable";
import "../Translation.css";

// Port of Signum.Translation's Instances/TranslatedInstanceSync.tsx — the page you translate INSTANCES on:
// everything whose text has no matching translation in this culture, with the machine suggestions offered
// in a combo (and the "edit" escape hatch, as on the code side).
//
// altea divergences: no rowId (a cell is its plain ROUTE — see the server's TranslatedInstanceLogic), and
// the combo helpers are the ones the code table already exports rather than a second copy.
export default function TranslatedInstanceSync(): React.JSX.Element {
    const params = useParams() as { type: string; culture: string };
    const location = useLocation();

    const type = params.type;
    const culture = params.culture;

    const [isLocked, lock] = useLock();
    const [applyFilter, setApplyFilter] = React.useState(new URLSearchParams(location.search).get("applyFilter") !== "false");

    const [result, reload] = useAPIWithReload(
        () => TranslatedInstanceClient.API.syncTranslatedInstance(type, culture, applyFilter),
        [type, culture, applyFilter]);

    const typeNiceName = nicePluralName(type);

    const message = result != undefined && result.totalInstances === 0
        ? TranslationMessage._0AlreadySynchronized.niceToString(typeNiceName)
        : TranslationMessage.Synchronize0In1.niceToString(typeNiceName, culture)
        + (result != undefined && result.instances.length < result.totalInstances
            ? ` [${result.instances.length}/${result.totalInstances}]` : "");
    useTitle(message);

    function handleSave(e: React.FormEvent): void {
        e.preventDefault();
        const records = result!.instances.flatMap(ins =>
            Dic.getKeys(ins.routeConflicts)
                .map(route => {
                    const change = ins.routeConflicts[route];
                    if (change.translatedText == undefined)
                        return undefined;
                    return {
                        lite: ins.instance,
                        propertyRoute: route,
                        culture,
                        originalText: change.support[result!.masterCulture]?.original ?? "",
                        translatedText: change.translatedText,
                    } satisfies TranslatedInstanceClient.TranslationRecord;
                })
                .notNull());

        void lock(() => TranslatedInstanceClient.API.saveTranslatedInstanceData(records, type, true, culture)
            .then(() => { reload(); Operations.notifySuccess(); }));
    }

    const filterToggle = (
        <label className="d-block mb-2 text-end">
            <input type="checkbox" checked={applyFilter} onChange={e => setApplyFilter(e.currentTarget.checked)} />
            {" "}{TranslationMessage.OnlyRecommendedInstances.niceToString()}
        </label>
    );

    const deleted = result != undefined && result.deletedTranslations > 0
        ? <p className="text-warning">{TranslationMessage._0OutdatedTranslationsFor1HaveBeenDeleted.niceToString(result.deletedTranslations, typeNiceName)}</p>
        : null;

    if (result != undefined && result.totalInstances === 0)
        return (
            <div>
                <div className="mb-2">
                    <h1 className="h2">{TranslationMessage._0AlreadySynchronized.niceToString(typeNiceName)}</h1>
                </div>
                {filterToggle}
                {deleted}
                <Link to="/translatedInstance/status">{TranslationMessage.BackToTranslationStatus.niceToString()}</Link>
            </div>
        );

    return (
        <div>
            <div className="mb-2">
                <h1 className="h2">
                    <Link to="/translatedInstance/status">{TranslationMessage.InstanceTranslations.niceToString()}</Link>
                    {" > "}{message}
                </h1>
            </div>
            {filterToggle}
            {deleted}
            {result != undefined &&
                <div>
                    {result.instances.map(ins =>
                        <AccessibleTable key={ins.instance.key()}
                            aria-label={TranslationMessage.TranslationsOverview.niceToString()}
                            className="table st"
                            mapCustomComponents={new Map<React.JSXElementConstructor<any>, string>([[SyncPropertyRows as React.JSXElementConstructor<any>, "tr"]])}
                            multiselectable={false}
                            style={{ width: "100%", margin: "0px" }}>
                            <thead>
                                <tr>
                                    <th className="leftCell">{TranslationMessage.Instance.niceToString()}</th>
                                    <th className="titleCell"><EntityLink lite={ins.instance} /></th>
                                </tr>
                            </thead>
                            <tbody>
                                {Dic.getKeys(ins.routeConflicts).map(route =>
                                    <SyncPropertyRows key={route} route={route} conflict={ins.routeConflicts[route]}
                                        data={result} currentCulture={culture} />)}
                            </tbody>
                        </AccessibleTable>)}
                    <input type="submit" value={TranslationMessage.Save.niceToString()} className="btn btn-primary mt-2"
                        onClick={handleSave} disabled={isLocked} />
                </div>}
        </div>
    );
}

function SyncPropertyRows(p: {
    route: string;
    conflict: TranslatedInstanceClient.PropertyChange;
    data: TranslatedInstanceClient.TypeInstancesChanges;
    currentCulture: string;
}): React.JSX.Element {

    const { route, conflict } = p;
    const isHtml = p.data.routes[route] === "Html";

    const [richView, setRichView] = React.useState(true);
    const [richEdit, setRichEdit] = React.useState(true);
    const [avoidCombo, setAvoidCombo] = React.useState(false);

    // The suggestion combo takes priority; the rich/raw toggle is hidden while it is showing.
    const canShowSelect = Dic.getKeys(conflict.support)
        .some(c => conflict.support[c].automaticTranslations.length > 0 || conflict.support[c].oldTranslation != undefined);
    const comboVisible = canShowSelect && !avoidCombo;

    function toggleButton(value: boolean, setValue: (v: boolean) => void): React.ReactElement {
        return (
            <LinkButton className="me-1 fw-normal" title={value ? "show code" : "show preview"} onClick={() => setValue(!value)}>
                <FontAwesomeIcon aria-hidden={true} icon={value ? "code" : "eye"} />
            </LinkButton>
        );
    }

    const rows: React.ReactElement[] = [
        <AccessibleRow key={`${route}-main`}>
            <th className="leftCell">{TranslationMessage.Property.niceToString()}</th>
            <th>{route}</th>
        </AccessibleRow>,
    ];

    for (const c of Dic.getKeys(conflict.support)) {
        const rc = conflict.support[c];
        const showDiff = rc.oldOriginal != undefined && rc.oldOriginal !== rc.original;
        const showRich = isHtml && richView && !showDiff;
        rows.push(
            <AccessibleRow key={`${route}-${c}`}>
                <td className="leftCell">
                    {isHtml && !showDiff && toggleButton(richView, setRichView)}
                    {c}
                </td>
                <td className="monospaceCell">
                    {showDiff
                        ? <DiffDocumentSimple first={rc.oldOriginal!} second={rc.original} />
                        : showRich
                            ? <TranslatedHtmlViewer text={rc.original} />
                            : <pre className={isHtml ? "mb-0 translation-raw-html" : "mb-0"} style={{ whiteSpace: "pre-wrap" }}>{rc.original}</pre>}
                </td>
            </AccessibleRow>);
    }

    rows.push(
        <AccessibleRow key={`${route}-translation`}>
            <td className="leftCell">
                {isHtml && !comboVisible && toggleButton(richEdit, setRichEdit)}
                {p.currentCulture}
            </td>
            <td className="monospaceCell">
                <TranslationProperty property={conflict} isHtml={isHtml} richEdit={richEdit}
                    avoidCombo={avoidCombo} setAvoidCombo={setAvoidCombo} />
            </td>
        </AccessibleRow>);

    return <>{rows}</>;
}

export function TranslationProperty(p: {
    property: TranslatedInstanceClient.PropertyChange;
    isHtml?: boolean;
    richEdit?: boolean;
    avoidCombo?: boolean;
    setAvoidCombo?: (v: boolean) => void;
}): React.JSX.Element {

    const { property } = p;
    const forceUpdate = useForceUpdate();

    const focusWhenTyping = React.useCallback((ta: HTMLTextAreaElement | null) => {
        if (ta != null && p.avoidCombo) ta.focus();
    }, [p.avoidCombo]);

    // Every source culture's machine suggestions, plus the PREVIOUS translation (which is often exactly
    // what you want back when only the original's wording changed).
    const translations = Object.entries(property.support).flatMap(([c, rc]) =>
        rc.automaticTranslations.map(at => ({ culture: c, text: at.text, translatorName: at.translatorName }))
            .concat(rc.oldTranslation != undefined
                ? [{ culture: c, text: rc.oldTranslation, translatorName: "Previous translation" }] : []));

    if (translations.length === 0 || p.avoidCombo)
        return p.isHtml && p.richEdit
            ? <TranslatedHtmlEditor text={property.translatedText} onChange={v => { property.translatedText = v; forceUpdate(); }} />
            : (
                <TextArea aria-label={TranslationMessage.Description.niceToString()}
                    className={p.isHtml ? "translation-raw-html" : undefined}
                    style={{ height: "24px", width: "90%" }} minHeight="24px" autoResize
                    value={property.translatedText ?? ""}
                    onChange={e => { property.translatedText = e.currentTarget.value; forceUpdate(); }}
                    innerRef={focusWhenTyping} />
            );

    return (
        <span>
            <select aria-label={TranslationMessage.Description.niceToString()} style={{ maxWidth: "70vw" }}
                value={property.translatedText ?? ""}
                onChange={e => { property.translatedText = e.currentTarget.value; forceUpdate(); }}
                onKeyDown={e => onEscapeToText(e, () => p.setAvoidCombo?.(true))}>
                {initialElementIf(property.translatedText == undefined)}
                {translations.map(a =>
                    <option key={a.culture + a.translatorName} value={a.text}
                        title={TranslationMessage.From0using1_.niceToString(a.culture, a.translatorName)}>
                        {a.text}
                    </option>)}
            </select>
            &nbsp;
            <LinkButton title={undefined} onClick={() => p.setAvoidCombo?.(true)}>{TranslationMessage.Edit.niceToString()}</LinkButton>
        </span>
    );
}

function nicePluralName(cleanName: string): string {
    const ctor = tryGetTypeInfo(cleanName)?.ctor as { nicePluralName?(): string } | undefined;
    return ctor?.nicePluralName?.() ?? cleanName;
}
