import * as React from "react";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPIWithReload } from "@altea/altea/client/Hooks";
import { Operations } from "@altea/altea/client/Operations";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes, Dic } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { TranslationMessage, TranslatedSummaryState, MatchTranslatedInstances } from "../../data/Translation";
import { TranslatedInstanceClient } from "../TranslatedInstanceClient";
import "../Translation.css";

// Port of Signum.Translation's Instances/TranslatedInstanceStatus.tsx — the entry point of the instance
// half: one row per TRANSLATABLE TYPE, one column per culture, plus the .xlsx upload.
export default function TranslatedInstanceStatus(): React.JSX.Element {
    const [applyFilter, setApplyFilter] = React.useState(true);
    const [result, reload] = useAPIWithReload(() => TranslatedInstanceClient.API.status(applyFilter), [applyFilter]);
    const [fileVer, setFileVer] = React.useState(0);

    function handleFile(e: React.ChangeEvent<HTMLInputElement>): void {
        const f = e.currentTarget.files?.[0];
        if (f == undefined)
            return;

        const reader = new FileReader();
        reader.onload = () => {
            const content = String(reader.result).after("base64,");
            const file: TranslatedInstanceClient.API.FileUpload = { content, fileName: f.name };
            setFileVer(v => v + 1);

            // chooseEnum yields the member NAME; the API takes the ordinal (altea enums are numeric).
            void SelectorModal.chooseEnum(MatchTranslatedInstances).then(name => {
                if (name == undefined)
                    return;
                void TranslatedInstanceClient.API.uploadFile(file, MatchTranslatedInstances[name])
                    .then(() => { Operations.notifySuccess(); reload(); });
            });
        };
        reader.readAsDataURL(f);
    }

    return (
        <div>
            <h1 className="h2">{TranslationMessage.InstanceTranslations.niceToString()}</h1>
            <label className="d-block mb-2 text-end">
                <input type="checkbox" checked={applyFilter} onChange={e => setApplyFilter(e.currentTarget.checked)} />
                {" "}{TranslationMessage.OnlyRecommendedInstances.niceToString()}
            </label>
            {result == undefined
                ? <p><strong>{JavascriptMessage.loading.niceToString()}</strong></p>
                : result.length === 0
                    ? <p>{TranslationMessage.NoRoutesMarkedForTranslationConsiderUsing.niceToString()} <code>@translatable</code></p>
                    : <TranslationTable result={result} onRefreshView={reload} applyFilter={applyFilter} />}
            {result != undefined && result.length > 0 &&
                <div>
                    <div className="btn-toolbar">
                        <input key={fileVer} type="file" onChange={handleFile}
                            style={{ display: "inline", float: "left", width: "inherit" }} />
                    </div>
                    <small>{TranslationMessage.SelectAxlsxFileWithTheTranslations.niceToString()}</small>
                </div>}
        </div>
    );
}

function TranslationTable(p: {
    result: TranslatedInstanceClient.TranslatedTypeSummary[];
    onRefreshView: () => void;
    applyFilter: boolean;
}): React.JSX.Element {

    const [onlyNeutral, setOnlyNeutral] = React.useState(true);

    const tree = p.result.groupBy(a => a.type)
        .toObject(gr => gr.key, gr => gr.elements.toObject(a => a.culture));

    const types = Dic.getKeys(tree);
    let cultures = types.length === 0 ? [] : Dic.getKeys(tree[types[0]]);
    if (onlyNeutral)
        cultures = cultures.filter(a => !a.includes("-"));

    const filterQuery = p.applyFilter ? "" : "?applyFilter=false";

    function handleAutoTranslate(type: string | null, culture: string): void {
        void MessageModal.show({
            title: TranslationMessage.AutoSync.niceToString(),
            message: type != null
                ? TranslationMessage.AreYouSureToContinueAutoTranslation0For1WithoutRevision.niceToString(niceName(type), culture)
                : TranslationMessage.AreYouSureToContinueAutoTranslationAllTypesFor0WithoutRevision.niceToString(culture),
            buttons: "yes_no",
            style: "warning",
            icon: "warning",
        }).then(mr => {
            if (mr === "yes")
                void (type != null
                    ? TranslatedInstanceClient.API.autoTranslate(type, culture)
                    : TranslatedInstanceClient.API.autoTranslateAll(culture))
                    .then(() => p.onRefreshView());
        });
    }

    return (
        <AccessibleTable aria-label={TranslationMessage.TranslationsOverview.niceToString()} className="table st" multiselectable={false}>
            <thead>
                <tr>
                    <th>
                        <label>
                            <input type="checkbox" checked={onlyNeutral} onChange={e => setOnlyNeutral(e.currentTarget.checked)} />
                            {" "}{TranslationMessage.OnlyNeutralCultures.niceToString()}
                        </label>
                    </th>
                    <th>{TranslationMessage.All.niceToString()}</th>
                    {cultures.map(culture =>
                        <th key={culture}>
                            <span>{culture}</span>
                            {p.result.some(r => !r.isDefaultCulture && r.culture === culture && r.state !== TranslatedSummaryState.Completed) &&
                                <LinkButton title={undefined} className={classes("auto-translate-all", culture, "ms-2")}
                                    onClick={() => handleAutoTranslate(null, culture)}>
                                    {TranslationMessage.AutoSync.niceToString()}
                                </LinkButton>}
                        </th>)}
                </tr>
            </thead>
            <tbody>
                {types.map(type =>
                    <tr key={type}>
                        <th>{nicePluralName(type)}</th>
                        <td>
                            <Link to={`/translatedInstance/view/${type}${filterQuery}`}>{TranslationMessage.View.niceToString()}</Link>
                        </td>
                        {cultures.map(culture => {
                            const summary = tree[type][culture];
                            if (summary.isDefaultCulture)
                                return <td key={culture}>{TranslationMessage.None.niceToString()}</td>;

                            const statusClass = "status-" + (summary.state == null ? "None" : TranslatedSummaryState[summary.state]);
                            return (
                                <td key={culture}>
                                    <Link to={`/translatedInstance/view/${type}/${culture}${filterQuery}`}>{TranslationMessage.View.niceToString()}</Link>
                                    <LinkButton className="ms-2" title={TranslationMessage.DownloadView.niceToString()}
                                        onClick={() => TranslatedInstanceClient.API.downloadView(type, culture, p.applyFilter)}>
                                        <FontAwesomeIcon aria-hidden="true" icon="download" />
                                    </LinkButton>
                                    <br />
                                    <Link to={`/translatedInstance/sync/${type}/${culture}${filterQuery}`} className={statusClass}>
                                        {TranslationMessage.Sync.niceToString()}
                                    </Link>
                                    <LinkButton className={classes(statusClass, "ms-2")} title={TranslationMessage.DownloadSync.niceToString()}
                                        onClick={() => TranslatedInstanceClient.API.downloadSync(type, culture, p.applyFilter)}>
                                        <FontAwesomeIcon aria-hidden="true" icon="download" />
                                    </LinkButton>
                                    {summary.state !== TranslatedSummaryState.Completed &&
                                        <>
                                            <br />
                                            <LinkButton title={undefined} className={classes("auto-translate", statusClass)}
                                                onClick={() => handleAutoTranslate(type, culture)}>
                                                {TranslationMessage.AutoSync.niceToString()}
                                            </LinkButton>
                                        </>}
                                </td>
                            );
                        })}
                    </tr>)}
            </tbody>
        </AccessibleTable>
    );
}

function niceName(cleanName: string): string {
    return tryGetTypeInfo(cleanName)?.ctor?.name ?? cleanName;
}

function nicePluralName(cleanName: string): string {
    const ctor = tryGetTypeInfo(cleanName)?.ctor as { nicePluralName?(): string } | undefined;
    return ctor?.nicePluralName?.() ?? cleanName;
}
