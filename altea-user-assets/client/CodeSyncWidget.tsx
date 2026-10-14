import * as React from "react";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { getTypeName } from "@altea/altea/client/Reflection";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { UserEntity } from "@altea/altea-auth/data/User";
import { CodeSyncMessage, CodeSyncMixin } from "../data/AssetSync";
import { AssetSyncClient } from "./AssetSyncClient";

export interface CodeSyncWidgetProps {
    ctx: TypeContext<Entity>;
}

/** The sync folder picker, shown at the end of the entity's button bar, followed by an icon for what the next
 *  sync will do to this asset (its title says it; it links to the sync panel). */
export function CodeSyncWidget(p: CodeSyncWidgetProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const mctx = p.ctx.subCtx(e => e.mixin(CodeSyncMixin), { formGroupStyle: "Basic" });
    const folderCtx = mctx.subCtx(m => m.syncFolder);
    const entity = p.ctx.value;
    const m = mctx.value;
    const owner = (entity as { owner?: Lite<Entity> | null }).owner;

    const info = useAPI(() => AssetSyncClient.API.info(), []);
    // Computed on the server from the file, so it is re-asked whenever the row was saved again.
    const status = useAPI(() => entity.isNew ? null : AssetSyncClient.API.statusOf(getTypeName(entity), String(entity.id)), [entity.id, entity.rowVersion]);
    const described = status == null ? undefined : AssetSyncClient.describe(status.comparison, status.keepOnSync);

    const title = described == undefined ? undefined : [
        described.text,
        info != undefined && !info.writeFiles ? CodeSyncMessage.ChangesHereAreNotWrittenToFiles.niceToString() : undefined,
        owner?.entityType === UserEntity ? CodeSyncMessage.APersonalAssetInASyncFolderWillBeOwnedByTheSameUserInEveryEnvironment.niceToString() : undefined,
    ].filter(a => a != undefined).join("\n");

    return (
        <div className="sf-code-sync ms-auto" style={{ width: "18rem", maxWidth: "100%" }}>
            <EntityCombo ctx={folderCtx} onChange={forceUpdate}
                extraButtons={() => m.syncFolder != null && described != undefined &&
                    <Link to={"/assetSync?folder=" + encodeURIComponent(status!.folder)} title={title}
                        className={`sf-line-button input-group-text text-${described.color}`}>
                        <FontAwesomeIcon aria-hidden={true} icon={described.icon} />
                    </Link>} />
        </div>
    );
}
