import * as React from "react";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { UserEntity } from "@altea/altea-auth/data/User";
import { CodeSyncMessage, CodeSyncMixin } from "../data/AssetSync";
import { AssetSyncClient } from "./AssetSyncClient";

export interface CodeSyncWidgetProps {
    ctx: TypeContext<Entity>;
}

export function CodeSyncWidget(p: CodeSyncWidgetProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const mctx = p.ctx.subCtx(e => e.mixin(CodeSyncMixin));
    const folderCtx = mctx.subCtx(m => m.syncFolder);
    const entity = p.ctx.value;
    const m = mctx.value;
    const owner = (entity as { owner?: Lite<Entity> | null }).owner;

    const info = useAPI(() => AssetSyncClient.API.info(), []);
    // Computed on the server from the file, so it is re-asked whenever the row was saved again.
    const status = useAPI(() => entity.isNew ? null : AssetSyncClient.API.statusOf(String(entity.id)), [entity.id, entity.rowVersion]);
    const described = status == null ? undefined : AssetSyncClient.describe(status.comparison, status.keepOnSync);

    return (
        <div className="sf-code-sync mb-2">
            <div className="d-flex align-items-center gap-2">
                <div className="flex-grow-1">
                    <EntityCombo ctx={folderCtx} onChange={forceUpdate} />
                </div>
                {m.syncFolder != null && described != undefined &&
                    <a href={"/assetSync?folder=" + encodeURIComponent(status!.folder)} className={`badge text-bg-${described.color} text-decoration-none`}>
                        {described.text}
                    </a>}
            </div>
            {m.syncFolder != null && info != undefined && !info.writeFiles &&
                <div className="form-text">{CodeSyncMessage.ChangesHereAreNotWrittenToFiles.niceToString()}</div>}
            {m.syncFolder != null && owner?.entityType === UserEntity &&
                <div className="alert alert-warning py-1 my-1">
                    {CodeSyncMessage.APersonalAssetInASyncFolderWillBeOwnedByTheSameUserInEveryEnvironment.niceToString()}
                </div>}
        </div>
    );
}
