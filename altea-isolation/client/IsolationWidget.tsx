import * as React from "react";
import type { BaseEntity, Entity } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import type { WidgetContext } from "@altea/altea/client/Frames/Widgets";
import { IsolationMessage, IsolationMixin, Isolation } from "../data/Isolation";
import { IsolationClient } from "./IsolationClient";

// The badge on an open entity saying which isolation it
// belongs to. A NEW entity shows the isolation it is about to be saved into (the picked one); a saved one
// shows its own. Nothing at all for a type that is not isolated.
export interface IsolationWidgetProps {
    wc: WidgetContext<BaseEntity>;
}

export function IsolationWidget(p: IsolationWidgetProps): React.JSX.Element | null {
    const entity = p.wc.ctx.value;

    // altea flattens a mixin onto its owner, so the
    // question is whether the mixin is DECLARED on this type — `entity.mixin(X)` throws when it is not.
    const declared = MixinDeclarations.getMixins(entity.getType())
        .some(m => m === (IsolationMixin));
    if (!declared)
        return null;

    const asEntity = entity as Entity;
    const isolation = asEntity.isNew
        ? IsolationClient.getOverridenIsolation()
        : Isolation.tryIsolation(asEntity);

    return (
        <strong className="badge btn-tertiary" style={{ display: "flex" }}>
            {isolation == null ? IsolationMessage.GlobalEntity.niceToString() : isolation.toString()}
        </strong>
    );
}
