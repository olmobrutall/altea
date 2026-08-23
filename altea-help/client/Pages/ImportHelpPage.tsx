import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { FontAwesomeIcon, type FontAwesomeIconProps } from "@fortawesome/react-fontawesome";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import { Enum } from "@altea/altea/data/enum";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import {
    HelpImportPreviewModel, HelpImportPreviewLineEmbedded,
    HelpImportReportModel, HelpImportReportLineEmbedded, HelpMessage,
    ImportActionEnum, ImportStatusEnum,
    type HelpFileUpload, type ImportAction, type ImportStatus,
} from "../../data/Help";
import { HelpClient } from "../HelpClient";
import "../Help.css";

// Port of Signum.Help's Pages/ImportHelpPage.tsx — pick a zip, see what it would change, tick the lines to
// apply, apply, read the report.
//
// altea divergences: a `@part` ROW array replaces the MList (so the tables read `model.lines` directly, no
// `mlistItemContext`/`.element` hop), and the enum labels come from `Enum.niceName` (altea's enums are a
// numeric object + a string union, not Signum's `EnumType` companion).
export default function ImportHelpPage(): React.JSX.Element {

    const [file, setFile] = React.useState<HelpFileUpload | undefined>(undefined);
    const [model, setModel] = React.useState<HelpImportPreviewModel | undefined>(undefined);
    const [report, setReport] = React.useState<HelpImportReportModel | undefined>(undefined);
    const [lastImported, setLastImported] = React.useState<string | undefined>(undefined);
    const [loading, setLoading] = React.useState(false);
    const [fileVer, setFileVer] = React.useState(0);

    const forceUpdate = useForceUpdate();

    useTitle(HelpMessage.ImportHelpContentsFromZipFile.niceToString());

    function handleInputChange(e: React.FormEvent<HTMLInputElement>): void {
        const picked = e.currentTarget.files?.[0];
        if (picked == null)
            return;

        setReport(undefined);
        setLoading(true);

        const reader = new FileReader();
        reader.onerror = () => { setLoading(false); };
        reader.onload = () => {
            const content = String(reader.result).after("base64,");
            const upload: HelpFileUpload = { content, fileName: picked.name };

            setFile(upload);
            setFileVer(fileVer + 1);

            HelpClient.API.importPreview(upload)
                .then(m => { setModel(m); setLoading(false); })
                .catch(e => { setLoading(false); throw e; });
        };
        reader.readAsDataURL(picked);
    }

    function handleImport(): void {
        setLoading(true);
        HelpClient.API.applyImport(file!, model!)
            .then(r => {
                setReport(r);
                setModel(undefined);
                setLastImported(file?.fileName);
                setFile(undefined);
                setLoading(false);
            })
            .catch(e => { setLoading(false); throw e; });
    }

    return (
        <div className="container">
            <h1 className="h2">{HelpMessage.ImportHelpContentsFromZipFile.niceToString()}</h1>
            <br />

            {report && <Report report={report} lastImported={lastImported} />}

            <ErrorBoundary>
                {loading ? <span>{JavascriptMessage.loading.niceToString()}</span>
                    : model ? <Preview model={model} file={file} onImport={handleImport} onChange={forceUpdate} />
                        : <FileInput fileVer={fileVer} onChange={handleInputChange} />}
            </ErrorBoundary>
        </div>
    );
}

function FileInput({ fileVer, onChange }: { fileVer: number; onChange: (e: React.FormEvent<HTMLInputElement>) => void }): React.JSX.Element {
    return (
        <div className="mb-3">
            <div className="btn-toolbar">
                <input key={fileVer} type="file" id="fileUpload" accept=".zip" onChange={onChange} className="d-none" />
                <label htmlFor="fileUpload" className="btn btn-info">
                    <FontAwesomeIcon icon="folder-open" className="me-2" aria-hidden={true} />
                    {HelpMessage.ChooseZIPFile.niceToString()}
                </label>
            </div>
            <small className="text-muted">
                {HelpMessage.SelectTheZIPFileWithTheHelpContentsThatYouWantToImport.niceToString()}
            </small>
        </div>
    );
}

const actionIcon: Record<ImportAction, FontAwesomeIconProps> = {
    Create: { icon: "square-plus", color: "green" },
    Override: { icon: "square-pen", color: "orange" },
    NoChange: { icon: "equals", color: "gray" },
};

const statusIcon: Record<ImportStatus, FontAwesomeIconProps> = {
    Applied: { icon: "square-check", color: "green" },
    Failed: { icon: "triangle-exclamation", color: "darkorange" },
    Skipped: { icon: "ban", color: "gray" },
    NoChange: { icon: "equals", color: "gray" },
};

function Preview({ model, file, onImport, onChange }: {
    model: HelpImportPreviewModel;
    file: HelpFileUpload | undefined;
    onImport: () => void;
    onChange: () => void;
}): React.JSX.Element {

    const fileSizeMB = file && (file.content.length * 3 / 4 / (1024 * 1024)).toFixed(2);

    function applyHeaderClick(): void {
        model.lines.forEach(l => { l.apply = l.action !== "NoChange"; });
        onChange();
    }

    return (
        <div>
            <AccessibleTable
                aria-label={HelpMessage.HelpZipContents.niceToString()}
                className="table import-preview"
                multiselectable={false}>
                <thead>
                    <tr>
                        <th>{HelpImportPreviewLineEmbedded.nicePropertyName(a => a.type)}</th>
                        <th>{HelpMessage.SelectedFile.niceToString()}</th>
                        <th>{`${HelpMessage.NewKey.niceToString()}`}</th>
                        <th>{HelpMessage.ActionStatus.niceToString()}</th>
                        <th onClick={applyHeaderClick} style={{ cursor: "pointer" }}>{HelpMessage.Import.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {model.lines.map((line, i) =>
                        <tr key={`${line.type.cleanName}-${i}`}
                            className={classes(line.apply === true && "row-selected", line.action === "NoChange" && "no-change")}>
                            <td>{tryGetTypeInfo(line.type.cleanName)?.getNiceName() ?? line.type.cleanName}</td>
                            <td>{`${line.culture.nativeName} (${line.culture.name})`}</td>
                            <td>{line.exitingEntity ? <EntityLink lite={line.exitingEntity} /> : line.key}</td>
                            <td>
                                <FontAwesomeIcon {...actionIcon[line.action]} className="me-2" size="lg" aria-hidden={true} />
                                {Enum.niceName(ImportActionEnum, line.action)}
                            </td>
                            <td>
                                {line.applyVisible() &&
                                    <input type="checkbox"
                                        aria-label={Enum.niceName(ImportActionEnum, line.action)}
                                        className="form-check-input"
                                        checked={line.apply === true}
                                        onChange={e => { line.apply = e.currentTarget.checked; onChange(); }} />}
                            </td>
                        </tr>)}
                </tbody>
            </AccessibleTable>

            <div className="alert alert-secondary d-flex align-items-center" role="alert">
                <FontAwesomeIcon icon="file" className="me-2" aria-hidden={true} />
                <div className="text-muted">
                    <strong>{HelpMessage.SelectedFile.niceToString()}:</strong> {file?.fileName} ({fileSizeMB} MB)
                </div>
            </div>

            <button onClick={onImport} className="btn btn-primary">
                <FontAwesomeIcon aria-hidden={true} icon="cloud-arrow-up" className="me-2" />
                {HelpMessage.Import.niceToString()}
            </button>
        </div>
    );
}

function Report({ report, lastImported }: { report: HelpImportReportModel; lastImported: string | undefined }): React.JSX.Element {

    const hasErrors = report.lines.some(l => l.status === "Failed");
    const message = (hasErrors ? HelpMessage.ImportCompletedWithErrors : HelpMessage.ImportCompletedSuccessfully).niceToString();

    return (
        <div>
            <div className={classes("alert d-flex align-items-center", hasErrors ? "alert-warning" : "alert-success")} role="alert">
                <FontAwesomeIcon icon="circle-check" className="me-2" aria-hidden={true} />
                <div><strong>{lastImported}</strong> {message}</div>
            </div>

            <h3 className="h3">{HelpMessage.ImportReport.niceToString()}</h3>

            <AccessibleTable
                aria-label={HelpMessage.ImportReport.niceToString()}
                className="table"
                multiselectable={false}>
                <thead>
                    <tr>
                        <th>{HelpImportReportLineEmbedded.nicePropertyName(a => a.type)}</th>
                        <th>{HelpMessage.SelectedFile.niceToString()}</th>
                        <th>{HelpMessage.NewKey.niceToString()}</th>
                        <th>{HelpMessage.ActionStatus.niceToString()}</th>
                        <th>{JavascriptMessage.error.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {report.lines.map((line, i) =>
                        <tr key={`${line.type.cleanName}-${i}`}>
                            <td>{tryGetTypeInfo(line.type.cleanName)?.getNiceName() ?? line.type.cleanName}</td>
                            <td>{`${line.culture.nativeName} (${line.culture.name})`}</td>
                            <td>{line.exitingEntity ? <EntityLink lite={line.exitingEntity} /> : line.key}</td>
                            <td>
                                <FontAwesomeIcon {...statusIcon[line.status]} className="me-2" size="lg"
                                    title={Enum.niceName(ImportStatusEnum, line.status)} aria-hidden={true} />
                                {Enum.niceName(ImportActionEnum, line.action)}
                            </td>
                            <td>{line.actionError}</td>
                        </tr>)}
                </tbody>
            </AccessibleTable>
        </div>
    );
}
