import * as React from "react";
import { useState } from "react";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { UserAssetClient } from "./UserAssetClient";
import { AssetSyncClient } from "./AssetSyncClient";
import { UserAssetMessage, UserAssetPreviewModel, EntityAction } from "../data/UserAssets";
import { CodeSyncMessage } from "../data/AssetSync";

// Upload an exported XML — or a sync-folder zip — preview what it would create / override (New / Different
// per asset, matched by uuid), tick the ones to override, then import.
export default function ImportAssetsPage(): React.JSX.Element {
    const [file, setFile] = useState<UserAssetClient.API.FileUpload | null>(null);
    const [zip, setZip] = useState<string | null>(null);
    const [keepOnSync, setKeepOnSync] = useState(false);
    const [model, setModel] = useState<UserAssetPreviewModel | null>(null);
    const [done, setDone] = useState(false);
    const forceUpdate = useForceUpdate();

    function handleFile(e: React.ChangeEvent<HTMLInputElement>): void {
        const f = e.currentTarget.files?.[0];
        if (f == null)
            return;
        setDone(false);
        setModel(null);
        const reader = new FileReader();
        if (f.name.toLowerCase().endsWith(".zip")) {
            reader.onload = () => {
                // A data URL: the base64 payload follows the comma.
                const content = (reader.result as string).split(",")[1] ?? "";
                setFile(null);
                setZip(content);
                AssetSyncClient.API.zipPreview(content).then(m => setModel(m));
            };
            reader.readAsDataURL(f);
        } else {
            reader.onload = () => {
                const fu: UserAssetClient.API.FileUpload = { fileName: f.name, content: reader.result as string };
                setZip(null);
                setFile(fu);
                UserAssetClient.API.importPreview(fu).then(m => setModel(m));
            };
            reader.readAsText(f);
        }
    }

    function handleImport(): void {
        if (model == null)
            return;
        if (zip != null)
            AssetSyncClient.API.zipImport(zip, model, keepOnSync).then(() => setDone(true));
        else if (file != null)
            UserAssetClient.API.importAssets({ file, model }).then(() => setDone(true));
    }

    return (
        <div>
            <h2 className="text-display-6 font-light">{UserAssetMessage.ImportUserAssets.niceToString()}</h2>
            <p className="text-muted-foreground">{UserAssetMessage.SelectTheXmlFileWithTheUserAssetsThatYouWantToImport.niceToString()}</p>
            <input type="file" accept=".xml,.zip" className="form-control mb-4" style={{ maxWidth: "30rem" }} onChange={handleFile} />

            {model != null &&
                <table className="table table-sm">
                    <thead>
                        <tr><th>Type</th><th>{UserAssetMessage.ImportPreview.niceToString()}</th><th>Action</th><th>{UserAssetMessage.Import.niceToString()}</th></tr>
                    </thead>
                    <tbody>
                        {model.lines.map((l, i) =>
                            <tr key={i}>
                                <td>{l.type}</td>
                                <td>{l.text}</td>
                                <td>{EntityAction[l.action]}</td>
                                <td>
                                    {l.action !== EntityAction.New &&
                                        <input type="checkbox" checked={l.overrideEntity}
                                            onChange={() => { l.overrideEntity = !l.overrideEntity; forceUpdate(); }} />}
                                </td>
                            </tr>)}
                    </tbody>
                </table>}

            {model != null && zip != null && !done &&
                <div className="form-check mb-2">
                    <input id="keepOnSync" type="checkbox" className="form-check-input" checked={keepOnSync} onChange={e => setKeepOnSync(e.currentTarget.checked)} />
                    <label htmlFor="keepOnSync" className="form-check-label">{CodeSyncMessage.KeepThroughTheNextSync.niceToString()}</label>
                </div>}

            {model != null && !done &&
                <button className="btn btn-primary" onClick={handleImport}>{UserAssetMessage.Import.niceToString()}</button>}
            {done && <p className="alert alert-success">{UserAssetMessage.SucessfullyImported.niceToString()}</p>}
        </div>
    );
}
