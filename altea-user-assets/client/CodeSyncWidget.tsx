import * as React from "react";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { UserEntity } from "@altea/altea-auth/data/User";
import { CodeSyncMessage, CodeSyncMixin, CodeSyncState } from "../data/AssetSync";

export interface CodeSyncWidgetProps {
    ctx: TypeContext<Entity>;
}

export function CodeSyncWidget(p: CodeSyncWidgetProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const mctx = p.ctx.subCtx(e => e.mixin(CodeSyncMixin));
    const folderCtx = mctx.subCtx(m => m.syncFolder);
    const m = mctx.value;
    const owner = (p.ctx.value as { owner?: Lite<Entity> | null }).owner;

    return (
        <div className="sf-code-sync mb-2">
            <div className="d-flex align-items-center gap-2">
                <div className="flex-grow-1">
                    <EntityCombo ctx={folderCtx} onChange={forceUpdate} />
                </div>
                {m.syncFolder != null && m.codeSyncState != null &&
                    <span className={m.codeSyncState === CodeSyncState.ModifiedInDb ? "badge text-bg-warning" : "badge text-bg-success"}>
                        {m.codeSyncState === CodeSyncState.ModifiedInDb
                            ? CodeSyncMessage.ModifiedInTheDatabase.niceToString()
                            : CodeSyncMessage.InSyncWithCode.niceToString()}
                    </span>}
            </div>
            {m.syncFolder != null && owner?.entityType === UserEntity &&
                <div className="alert alert-warning py-1 my-1">
                    {CodeSyncMessage.APersonalAssetInASyncFolderWillBeOwnedByTheSameUserInEveryEnvironment.niceToString()}
                </div>}
        </div>
    );
}
