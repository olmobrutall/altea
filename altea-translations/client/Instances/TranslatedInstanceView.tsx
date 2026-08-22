import * as React from "react";
import { Link, useLocation, useParams } from "react-router";
import { Operations } from "@altea/altea/client/Operations";
import { AccessibleRow, AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import TextArea from "@altea/altea/client/Components/TextArea";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { useAPIWithReload, useForceUpdate, useLock } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { CultureClient } from "@altea/altea/client/CultureClient";
import { useAPI } from "@altea/altea/client/Hooks";
import { Dic } from "@altea/altea/data/globals";
import { DiffDocumentSimple } from "@altea/altea-diff-log/client/Templates/DiffDocument";
import "@altea/altea-diff-log/client/Templates/DiffLog.css";
import { TranslationMessage } from "../../data/Translation";
import { TranslatedInstanceClient } from "../TranslatedInstanceClient";
import { TranslatedHtmlEditor, TranslatedHtmlViewer } from "./TranslatedHtml";
import { TranslateSearchBox } from "../Code/TranslationCodeView";
import "../Translation.css";

// Port of Signum.Translation's Instances/TranslatedInstanceView.tsx — read and hand-edit the translations
// that exist, one table per instance.
//
// altea divergences:
//  - a cell is addressed by its plain ROUTE (no rowId — see the server's TranslatedInstanceLogic), so
//    Signum's `"route;rowId"` splitting and its `"a/b" → "a[7].b"` display rewriting are gone.
//  - the search box is the one the code view already defines, rather than a second copy.
export default function TranslatedInstanceView(): React.JSX.Element {
    const params = useParams() as { type: string; culture?: string };
    const location = useLocation();

    const type = params.type;
    const culture = params.culture;

    const cultures = useAPI(() => CultureClient.getCultures(), []);
    const [isLocked, lock] = useLock();

    const [onlyNeutral, setOnlyNeutral] = React.useState(true);
    const [applyFilter, setApplyFilter] = React.useState(new URLSearchParams(location.search).get("applyFilter") !== "false");
    const [filter, setFilter] = React.useState<string | undefined>(() => new URLSearchParams(location.search).get("filter") ?? undefined);

    const [result, reload] = useAPIWithReload(
        () => filter == undefined
            ? Promise.resolve(undefined)
            : TranslatedInstanceClient.API.viewTranslatedInstanceData(type, culture, filter, applyFilter),
        [type, culture, filter, applyFilter]);

    const message = TranslationMessage.View0In1.niceToString(type,
        culture ?? TranslationMessage.AllLanguages.niceToString());
    useTitle(message);

    function handleSave(e: React.FormEvent): void {
        e.preventDefault();
        const records = result!.instances.flatMap(ins =>
            Dic.getKeys(ins.translations).flatMap(route =>
                Dic.getKeys(ins.translations[route])
                    .filter(c => culture == undefined || culture === c)
                    .map(c => ({
                        lite: ins.lite,
                        propertyRoute: route,
                        culture: c,
                        originalText: ins.translations[route][c].newText ?? ins.translations[route][c].originalText,
                        translatedText: ins.translations[route][c].translatedText,
                    } satisfies TranslatedInstanceClient.TranslationRecord))));

        void lock(() => TranslatedInstanceClient.API.saveTranslatedInstanceData(records, type, false, culture)
            .then(() => { reload(); Operations.notifySuccess(); }));
    }

    const otherCultures = (cultures == undefined ? [] : Object.keys(cultures.cultures))
        .filter(a => a !== result?.masterCulture)
        .filter(a => !onlyNeutral || !a.includes("-"));

    return (
        <div>
            <div className="mb-2">
                <h1 className="h2">
                    <Link to="/translatedInstance/status">{TranslationMessage.InstanceTranslations.niceToString()}</Link>
                    {" > "}{message}
                </h1>
                <TranslateSearchBox filter={filter ?? ""} setFilter={setFilter} />
                <label style={{ float: "right" }} className="ms-3">
                    <input type="checkbox" checked={applyFilter} onChange={e => setApplyFilter(e.currentTarget.checked)} />
                    {" "}{TranslationMessage.OnlyRecommendedInstances.niceToString()}
                </label>
                {culture == undefined &&
                    <label style={{ float: "right" }}>
                        <input type="checkbox" checked={onlyNeutral} onChange={e => setOnlyNeutral(e.currentTarget.checked)} />
                        {" "}{TranslationMessage.OnlyNeutralCultures.niceToString()}
                    </label>}
                <em>{TranslationMessage.PressSearchForResults.niceToString()}</em>
            </div>
            {result != undefined && (result.instances.length === 0
                ? <strong>{TranslationMessage.NoResultsFound.niceToString()}</strong>
                : (
                    <div id="results">
                        {result.instances.map(ins =>
                            <TranslatedInstance key={ins.lite.key()} ins={ins} data={result}
                                cultures={culture != undefined ? [culture] : otherCultures} currentCulture={culture} />)}
                        <input type="submit" value={TranslationMessage.Save.niceToString()} className="btn btn-primary mt-2"
                            onClick={handleSave} disabled={isLocked} />
                    </div>
                ))}
        </div>
    );
}

function TranslatedInstance(p: {
    ins: TranslatedInstanceClient.TranslatedInstanceView;
    data: TranslatedInstanceClient.TranslatedInstanceViewType;
    cultures: string[];
    currentCulture?: string;
}): React.JSX.Element {
    return (
        <AccessibleTable
            aria-label={TranslationMessage.TranslationsOverview.niceToString()}
            className="table st"
            mapCustomComponents={new Map<React.JSXElementConstructor<any>, string>([[TranslatedInstanceProperty as React.JSXElementConstructor<any>, "tr"]])}
            multiselectable={false}>
            <thead>
                <tr>
                    <th className="leftCell">{TranslationMessage.Instance.niceToString()}</th>
                    <th className="titleCell"><EntityLink lite={p.ins.lite} /></th>
                </tr>
            </thead>
            <tbody>
                {Dic.getKeys(p.ins.master).map(route =>
                    <TranslatedInstanceProperty key={route} route={route} ins={p.ins} data={p.data}
                        cultures={p.cultures} currentCulture={p.currentCulture} />)}
            </tbody>
        </AccessibleTable>
    );
}

function TranslatedInstanceProperty(p: {
    route: string;
    ins: TranslatedInstanceClient.TranslatedInstanceView;
    data: TranslatedInstanceClient.TranslatedInstanceViewType;
    cultures: string[];
    currentCulture?: string;
}): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const { route, ins } = p;
    const isHtml = p.data.routes[route] === "Html";
    const [rich, setRich] = React.useState(true);
    const showRich = isHtml && rich;

    const trans = ins.translations[route];

    function handleChange(culture: string, newValue: string): void {
        const byCulture = ins.translations[route] ??= {};
        if (byCulture[culture] == undefined)
            byCulture[culture] = { originalText: ins.master[route] ?? "", newText: ins.master[route], translatedText: newValue };
        else
            byCulture[culture].translatedText = newValue;
        forceUpdate();
    }

    const rows: React.ReactElement[] = [
        <AccessibleRow key={`${route}-header`}>
            <th className="leftCell">{TranslationMessage.Property.niceToString()}</th>
            <th>
                {route}
                {isHtml &&
                    <LinkButton className="ms-2 fw-normal" title={TranslationMessage.Edit.niceToString()} onClick={() => setRich(!rich)}>
                        <FontAwesomeIcon aria-hidden={true} icon={showRich ? "code" : "align-left"} />
                    </LinkButton>}
            </th>
        </AccessibleRow>,
        <AccessibleRow key={`${route}-master`}>
            <td className="leftCell"><em>{p.data.masterCulture}</em></td>
            <td className="monospaceCell">{renderText(ins.master[route], isHtml, showRich)}</td>
        </AccessibleRow>,
    ];

    for (const c of p.cultures) {
        const pair = trans?.[c];

        // The row's text CHANGED since this translation was made: show what changed, so the reviewer can
        // decide whether the translation still holds.
        if (pair != undefined && pair.originalText != undefined && pair.newText != undefined && pair.originalText !== pair.newText)
            rows.push(
                <AccessibleRow key={`${route}-${c}-diff`}>
                    <td className="leftCell">{c} Diff</td>
                    <td className="monospaceCell"><pre><DiffDocumentSimple first={pair.originalText} second={pair.newText} /></pre></td>
                </AccessibleRow>);

        const editable = p.currentCulture == undefined || p.currentCulture === c;

        rows.push(
            <AccessibleRow key={`${route}-${c}`}>
                <td className="leftCell">{c}</td>
                <td className="monospaceCell">
                    {editable
                        ? (showRich
                            ? <TranslatedHtmlEditor text={pair?.translatedText ?? ""} onChange={v => handleChange(c, v)} />
                            : <TextArea className={isHtml ? "translation-raw-html" : undefined}
                                style={{ height: "24px", width: "90%" }} minHeight="24px" autoResize
                                value={pair?.translatedText ?? ""}
                                onChange={e => handleChange(c, e.currentTarget.value)} />)
                        : pair != undefined && renderText(pair.translatedText, isHtml, showRich)}
                </td>
            </AccessibleRow>);
    }

    return <>{rows}</>;
}

function renderText(text: string | null | undefined, isHtml: boolean, showRich: boolean): React.ReactNode {
    if (showRich)
        return <TranslatedHtmlViewer text={text} />;
    if (isHtml)
        return <pre className="translation-raw-html" style={{ whiteSpace: "pre-wrap" }}>{text}</pre>;
    return text;
}
