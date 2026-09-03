import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { DynamicMixinConnectionEntity } from "../../data/DynamicMixinConnection";

// Port of Signum.Dynamic's Type/DynamicMixinConnection.tsx — verbatim.
//
// The hint is altea's: a connection takes effect only after a RESTART (the declaration has to happen while
// the schema is built) and then a sync (the mixin's fields are new columns on the owner's table). Signum
// says the same thing through DynamicTypeMessage.TheEntityShouldBeSynchronizedToApplyMixins.
export default function DynamicMixinConnectionComponent(
    p: { ctx: TypeContext<DynamicMixinConnectionEntity> },
): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} />
            <AutoLine ctx={ctx.subCtx(a => a.mixinName)}
                helpText="The mixin's type name — usually a DynamicType whose base is MixinEntity. Takes effect after a restart and a schema sync." />
        </div>
    );
}
