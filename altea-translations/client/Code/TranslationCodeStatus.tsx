import * as React from "react";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPIWithReload } from "@altea/altea/client/Hooks";
import { saveFile } from "@altea/altea/client/Services";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { classes, Dic } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { TranslationMessage, TranslatedSummaryState } from "../../data/Translation";
import { TranslationClient, encodePackage } from "../TranslationClient";
import "../Translation.css";

// Port of Signum.Translation's Code/TranslationCodeStatus.tsx — the entry point of the code half: one row
// per PACKAGE, one column per culture, each cell linking to view / sync / auto-sync.
export default function TranslationCodeStatus(): React.JSX.Element {
    const [result, reload] = useAPIWithReload(() => TranslationClient.API.status(), []);

    return (
        <div>
            <h1 className="h2">{TranslationMessage.CodeTranslations.niceToString()}</h1>
            {result == undefined
                ? <strong>{JavascriptMessage.loading.niceToString()}</strong>
                : <TranslationTable result={result} onRefreshView={reload} />}
        </div>
    );
}

function TranslationTable(p: { result: TranslationClient.TranslationFileStatus[]; onRefreshView: () => void }): React.JSX.Element {
    const [onlyNeutral, setOnlyNeutral] = React.useState(true);

    const tree = p.result.groupBy(a => a.package)
        .toObject(gr => gr.key, gr => gr.elements.toObject(a => a.culture));

    const packages = Dic.getKeys(tree);
    let cultures = packages.length === 0 ? [] : Dic.getKeys(tree[packages[0]]);
    if (onlyNeutral)
        cultures = cultures.filter(a => !a.includes("-"));

    function handleAutoTranslate(packageName: string | null, culture: string): void {
        void MessageModal.show({
            title: TranslationMessage.AutoSync.niceToString(),
            message: packageName != null
                ? TranslationMessage.AreYouSureToContinueAutoTranslation0For1WithoutRevision.niceToString(packageName, culture)
                : TranslationMessage.AreYouSureToContinueAutoTranslationAllPackagesFor0WithoutRevision.niceToString(culture),
            buttons: "yes_no",
            style: "warning",
            icon: "warning",
        }).then(mr => {
            if (mr === "yes")
                void (packageName != null
                    ? TranslationClient.API.autoTranslate(packageName, culture)
                    : TranslationClient.API.autoTranslateAll(culture))
                    .then(() => p.onRefreshView());
        });
    }

    return (
        <AccessibleTable aria-label={TranslationMessage.TranslationStatus.niceToString()} className="st">
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
                            {culture}
                            {p.result.some(r => !r.isDefault && r.culture === culture && r.status !== TranslatedSummaryState.Completed) &&
                                <LinkButton title={undefined} className={classes("auto-translate-all", culture, "ms-2")}
                                    onClick={() => handleAutoTranslate(null, culture)}>
                                    {TranslationMessage.AutoSync.niceToString()}
                                </LinkButton>}
                        </th>)}
                </tr>
            </thead>
            <tbody>
                {packages.map(packageName =>
                    <tr key={packageName}>
                        <th>{packageName}</th>
                        <td>
                            <Link to={`/translation/view/${encodePackage(packageName)}`}>{TranslationMessage.View.niceToString()}</Link>
                        </td>
                        {cultures.map(culture => {
                            const fileStatus = tree[packageName][culture];
                            const statusClass = "status-" + TranslatedSummaryState[fileStatus.status];
                            return (
                                <td key={culture}>
                                    <Link to={`/translation/view/${encodePackage(packageName)}/${culture}`}>{TranslationMessage.View.niceToString()}</Link>
                                    {fileStatus.status !== TranslatedSummaryState.None &&
                                        <LinkButton className="ms-2" title={TranslationMessage.Download.niceToString()}
                                            onClick={() => void TranslationClient.API.download(packageName, culture).then(r => saveFile(r))}>
                                            <FontAwesomeIcon aria-hidden="true" icon="download" />
                                        </LinkButton>}
                                    <br />
                                    {!fileStatus.isDefault &&
                                        <Link to={`/translation/syncFolders/${encodePackage(packageName)}/${culture}`} className={statusClass}>
                                            {TranslationMessage.Sync.niceToString()}
                                        </Link>}
                                    {!fileStatus.isDefault && fileStatus.status !== TranslatedSummaryState.Completed &&
                                        <>
                                            <br />
                                            <LinkButton title={undefined} className={classes("auto-translate", statusClass)}
                                                onClick={() => handleAutoTranslate(packageName, culture)}>
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
