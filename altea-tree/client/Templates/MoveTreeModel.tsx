import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { Lite } from "@altea/altea/data/lite";
import { InsertPlace, type MoveTreeModel, type TreeEntity } from "../../data/Tree";
import { TreeClient } from "../TreeClient";

// Port of Signum.Tree's Templates/MoveTreeModel.tsx — the "where do you want it?" modal both Move and Copy
// open. `lite` is the node being moved, injected through `extraProps` (Signum does the same).
//
// altea divergences:
//  - **no `type={…}` prop.** An altea Line reads its type off `ctx.memberType` (see CLAUDE.md), so
//    Signum's hand-built `{ name: typeName, isLite: true } as TypeReference` — needed because
//    `newParent`/`sibling` are declared `Lite<TreeEntity>`, i.e. the ABSTRACT base — is unnecessary: the
//    findOptions' `queryName` already narrows the picker to the concrete type.
//  - **the tokens are ROOTLESS strings.** `QueryTokenString.entity()` is `""` and
//    `QueryTokenString.entity<TreeEntity>().expression("Parent")` is `"Parent"` — a registered expression
//    is PascalCase, like every other system token.
export interface MoveTreeModelComponentProps {
    ctx: TypeContext<MoveTreeModel>;
    lite: Lite<TreeEntity>;
}

export default function MoveTreeModelComponent(p: MoveTreeModelComponentProps): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const typeName = p.lite.entityType.name;

    // "Anything but the node itself" — moving a node under itself would cut the subtree loose.
    const notItself = [{ token: "", operation: "DistinctTo", value: p.lite, frozen: true }] as const;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.newParent)} onChange={() => forceUpdate()}
                findOptions={{ queryName: typeName, filterOptions: [...notItself] }}
                onFind={() => TreeClient.openTree({ typeName, filterOptions: [...notItself] })} />

            <AutoLine ctx={ctx.subCtx(a => a.insertPlace)} onChange={() => forceUpdate()} />

            {(ctx.value.insertPlace === InsertPlace.Before || ctx.value.insertPlace === InsertPlace.After) &&
                <EntityLine ctx={ctx.subCtx(a => a.sibling)}
                    findOptions={{ queryName: typeName, filterOptions: [{ token: "Parent", value: ctx.value.newParent }] }}
                    onFind={() => TreeClient.openTree({ typeName, filterOptions: [{ token: "Parent", value: ctx.value.newParent }] })} />}
        </div>
    );
}
