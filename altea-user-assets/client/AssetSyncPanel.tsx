import * as React from "react";
import { useLocation } from "react-router";
import { useAPI, useAPIWithReload } from "@altea/altea/client/Hooks";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { DiffDocument } from "@altea/altea-diff-log/client/Templates/DiffDocument";
import { CodeSyncMessage, SyncFolderEntity } from "../data/AssetSync";
import { UserAssetMessage } from "../data/UserAssets";
import type { AssetSyncDiff, AssetSyncReport, AssetSyncStatus } from "../data/AssetSyncDtos";
import { AssetSyncClient } from "./AssetSyncClient";
import { colorClass } from "@altea/altea/client/Components";

// Every synced asset and every asset file, with how they compare — always computed, never stored — and
// what the next sync will do with each. See port/UserAssetCodeSync.md.
export default function AssetSyncPanel(): React.JSX.Element {
    const location = useLocation();
    const [folder, setFolder] = React.useState<string>(() => new URLSearchParams(location.search).get("folder") ?? "");
    const info = useAPI(() => AssetSyncClient.API.info(), []);
    const [lines, reload] = useAPIWithReload(() => AssetSyncClient.API.status(folder || undefined), [folder]);
    const [report, setReport] = React.useState<AssetSyncReport | string[] | null>(null);
    const [diffs, setDiffs] = React.useState<Record<string, AssetSyncDiff | undefined>>({});
    const [busy, setBusy] = React.useState(false);

    async function run<T>(action: () => Promise<T>, show?: (result: T) => void): Promise<void> {
        setBusy(true);
        try {
            const result = await action();
            show?.(result);
            setDiffs({});
            reload();
        } finally {
            setBusy(false);
        }
    }

    function toggleDiff(guid: string): void {
        if (diffs[guid] != undefined) {
            setDiffs({ ...diffs, [guid]: undefined });
            return;
        }
        AssetSyncClient.API.diff(guid).then(d => setDiffs(ds => ({ ...ds, [guid]: d })));
    }

    return (
        <div>
            <h2 className="text-display-6 font-light">{CodeSyncMessage.AssetSync.niceToString()}</h2>

            <div className="flex flex-wrap items-center gap-2 mb-4">
                <select className="sf-form-select" style={{ maxWidth: "15rem" }} value={folder} onChange={e => setFolder(e.currentTarget.value)}>
                    <option value="">*</option>
                    {info?.folders.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <button className="sf-btn sf-btn-primary" disabled={busy}
                    onClick={() => run(() => AssetSyncClient.API.sync(folder ? [folder] : undefined), setReport)}>
                    {CodeSyncMessage.SyncFromCode.niceToString()}
                </button>
                {info?.writeFiles &&
                    <button className="sf-btn sf-btn-tertiary" disabled={busy}
                        onClick={() => run(() => AssetSyncClient.API.rewriteFiles(), setReport)}>
                        {CodeSyncMessage.RewriteFiles.niceToString()}
                    </button>}
                <a className="sf-btn sf-btn-tertiary" href="/userAssets/import">{UserAssetMessage.ImportUserAssets.niceToString()}</a>
                {info != undefined && !info.writeFiles &&
                    <span className="sf-form-text">{CodeSyncMessage.ChangesHereAreNotWrittenToFiles.niceToString()}</span>}
            </div>

            {report != null && <ReportView report={report} onClose={() => setReport(null)} />}

            <table className="sf-table sf-table-sm align-middle">
                <thead>
                    <tr>
                        <th>{SyncFolderEntity.niceName()}</th>
                        <th>{TypeEntity.niceName()}</th>
                        <th />
                        <th />
                        <th>{CodeSyncMessage.KeepOnSync.niceToString()}</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {lines?.map(l => <React.Fragment key={l.guid}>
                        <StatusRow line={l} busy={busy} writeFiles={info?.writeFiles ?? false} diffShown={diffs[l.guid] != undefined}
                            onToggleDiff={() => toggleDiff(l.guid)}
                            onKeep={keep => run(() => AssetSyncClient.API.setKeepOnSync(l.guid, keep))}
                            onApplyFile={() => run(() => AssetSyncClient.API.applyFile(l.guid))}
                            onWriteFile={() => run(() => AssetSyncClient.API.writeFile(l.guid))} />
                        {diffs[l.guid] != undefined &&
                            <tr><td colSpan={6}><DiffView diff={diffs[l.guid]!} /></td></tr>}
                    </React.Fragment>)}
                </tbody>
            </table>
        </div>
    );
}

interface StatusRowProps {
    line: AssetSyncStatus;
    busy: boolean;
    writeFiles: boolean;
    diffShown: boolean;
    onToggleDiff: () => void;
    onKeep: (keep: boolean) => void;
    onApplyFile: () => void;
    onWriteFile: () => void;
}

function StatusRow(p: StatusRowProps): React.JSX.Element {
    // The listing leaves the comparison of an asset with a file AND a row to this row's own request, so
    // every row resolves at the same time instead of the whole folder waiting for the slowest.
    const compared = useAPI(() => p.line.comparison != null ? Promise.resolve(p.line) : AssetSyncClient.API.statusOf(p.line.type, p.line.guid), [p.line]);
    if (compared === null) // gone since the listing (deleted, or its file removed)
        return <></>;
    const l = compared ?? p.line;
    if (l.comparison == null)
        return (
            <tr>
                <td>{l.folder}</td>
                <td>{l.type}</td>
                <td><a href={`/view/${l.type}/${l.guid}`}>{l.name}</a></td>
                <td><span className="sf-spinner-border sf-spinner-border-sm text-muted-foreground" role="status" /></td>
                <td /><td />
            </tr>
        );
    const d = AssetSyncClient.describe(l.comparison, l.keepOnSync);
    const inDb = l.comparison !== "NotInDatabase";
    const inCode = l.comparison !== "NotInCode";
    return (
        <tr>
            <td>{l.folder}</td>
            <td>{l.type}</td>
            <td>{inDb ? <a href={`/view/${l.type}/${l.guid}`}>{l.name}</a> : l.name}</td>
            <td><span className={`sf-badge ${colorClass("text-bg", d.color)}`}>{d.text}</span></td>
            <td>{inDb && <input type="checkbox" className="sf-form-check-input" checked={l.keepOnSync} disabled={p.busy}
                onChange={e => p.onKeep(e.currentTarget.checked)} />}</td>
            <td className="text-nowrap">
                {l.comparison !== "Identical" &&
                    <button className="sf-btn sf-btn-sm sf-btn-link" onClick={p.onToggleDiff}>{CodeSyncMessage.ShowDifferences.niceToString()}</button>}
                {inCode && l.comparison !== "Identical" &&
                    <button className="sf-btn sf-btn-sm sf-btn-tertiary" disabled={p.busy} onClick={p.onApplyFile}>{CodeSyncMessage.ApplyFile.niceToString()}</button>}
                {p.writeFiles && inDb && l.comparison !== "Identical" &&
                    <button className="sf-btn sf-btn-sm sf-btn-tertiary ms-1" disabled={p.busy} onClick={p.onWriteFile}>{CodeSyncMessage.WriteFile.niceToString()}</button>}
            </td>
        </tr>
    );
}

// The FILE is the base and the DATABASE the change, as in a git diff of the database against the code.
function DiffView(p: { diff: AssetSyncDiff }): React.JSX.Element {
    return (
        <div>
            <h6>{CodeSyncMessage.File.niceToString()} → {CodeSyncMessage.Database.niceToString()}</h6>
            <DiffDocument first={p.diff.file ?? ""} second={p.diff.database ?? ""} />
        </div>
    );
}

const reportLabels: Record<keyof AssetSyncReport | "rewritten", () => string> = {
    created: () => CodeSyncMessage.Created.niceToString(),
    updated: () => CodeSyncMessage.Updated.niceToString(),
    unchanged: () => CodeSyncMessage.Unchanged.niceToString(),
    reset: () => CodeSyncMessage.NoLongerKept.niceToString(),
    kept: () => CodeSyncMessage.Kept.niceToString(),
    deleted: () => CodeSyncMessage.Deleted.niceToString(),
    notInCode: () => CodeSyncMessage.NotInCode.niceToString(),
    rewritten: () => CodeSyncMessage.Rewritten.niceToString(),
};

function ReportView(p: { report: AssetSyncReport | string[]; onClose: () => void }): React.JSX.Element {
    const entries = (Array.isArray(p.report) ? [["rewritten", p.report]] : Object.entries(p.report)) as [keyof typeof reportLabels, string[]][];
    return (
        <div className="sf-alert sf-alert-info">
            <button type="button" className="sf-btn-close float-end" onClick={p.onClose} />
            {entries.map(([k, v]) => <div key={k}>
                <strong>{reportLabels[k]()}</strong>: {v.length}
                {v.length > 0 && <ul className="mb-1">{v.map(x => <li key={x}>{x}</li>)}</ul>}
            </div>)}
        </div>
    );
}
