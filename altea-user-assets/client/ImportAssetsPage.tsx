import * as React from "react";
import { useState } from "react";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { UserAssetClient } from "./UserAssetClient";
import { UserAssetMessage, UserAssetPreviewModel, EntityAction } from "../data/UserAssets";

// Port of Signum's Signum.UserAssets/ImportAssetsPage.tsx — upload an exported XML, preview what it would
// create/override (New/Different per asset, matched by uuid), tick the ones to override, then import.
export default function ImportAssetsPage(): React.JSX.Element {
    const [file, setFile] = useState<UserAssetClient.API.FileUpload | null>(null);
    const [model, setModel] = useState<UserAssetPreviewModel | null>(null);
    const [done, setDone] = useState(false);
    const forceUpdate = useForceUpdate();

    function handleFile(e: React.ChangeEvent<HTMLInputElement>): void {
        const f = e.currentTarget.files?.[0];
        if (f == null)
            return;
        const reader = new FileReader();
        reader.onload = () => {
            const fu: UserAssetClient.API.FileUpload = { fileName: f.name, content: reader.result as string };
            setFile(fu);
            setDone(false);
            UserAssetClient.API.importPreview(fu).then(m => setModel(m));
        };
        reader.readAsText(f);
    }

    function handleImport(): void {
        if (file != null && model != null)
            UserAssetClient.API.importAssets({ file, model }).then(() => setDone(true));
    }

    return (
        <div>
            <h2 className="display-6">{UserAssetMessage.ImportUserAssets.niceToString()}</h2>
            <p className="text-muted">{UserAssetMessage.SelectTheXmlFileWithTheUserAssetsThatYouWantToImport.niceToString()}</p>
            <input type="file" accept=".xml" className="form-control mb-3" style={{ maxWidth: "30rem" }} onChange={handleFile} />

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

            {model != null && !done &&
                <button className="btn btn-primary" onClick={handleImport}>{UserAssetMessage.Import.niceToString()}</button>}
            {done && <p className="alert alert-success">{UserAssetMessage.SucessfullyImported.niceToString()}</p>}
        </div>
    );
}
