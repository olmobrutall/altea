import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import "@altea/altea/client/EntityTypeApi"; // installs Type.findOptions / token
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { UserAssetMessage } from "@altea/altea-user-assets/data/UserAssets";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarMessage, type ToolbarMenuElementEmbedded,
} from "../../data/Toolbar";
import { ToolbarElementTable } from "./Toolbar";

// Faithful port of Signum's Templates/ToolbarMenu.tsx (Signum.Toolbar/Templates/ToolbarMenu.tsx): the
// ToolbarMenu editor. When the menu is bound to an entity type, its elements are edited in three tabs — the
// ones shown with NO entity selected, the ones shown WITH one, and both together.
//
// altea divergences:
//  - Signum's unused `getNiceTypeName` / `getTypeInfo` imports are dropped.
//  - `getToString(ctx.value.entityType)` → `ctx.value.entityType.toString()` (a TypeEntity lite's toStr is its
//    clean name).
//  - The "Used by" search lines use altea's `Type.findOptions(token => …)` builder, which is the same shape
//    Signum used here.

export default function ToolbarMenu(p: { ctx: TypeContext<ToolbarMenuEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: 4 });

    const forceUpdate = useForceUpdate();
    return (
        <div>
            <AutoLine ctx={ctx.subCtx(f => f.name)} />
            <EntityLine ctx={ctx.subCtx(f => f.owner)} />
            <EntityLine ctx={ctx.subCtx(f => f.entityType)} onChange={() => {
                forceUpdate();
            }} />
            {!ctx.value.isNew && <CollapsableCard header={UserAssetMessage.Advanced.niceToString()} size="xs">

                <div>
                    <h2 className="mt-3 h5">{UserAssetMessage.UsedBy.niceToString()}</h2>
                    <div className="row">
                        <div className="col-sm-6">
                            <SearchValueLine ctx={ctx4} findOptions={ToolbarMenuEntity.findOptions(token => ({ filterOptions: [token(a => a.entity.elements).any().append(a => a.content).filter("EqualTo", ctx.value)] }))} />
                            <SearchValueLine ctx={ctx4} findOptions={ToolbarEntity.findOptions(token => ({ filterOptions: [token(a => a.entity.elements).any().append(a => a.content).filter("EqualTo", ctx.value)] }))} />
                        </div>
                        <div className="col-sm-6">
                            <SearchValueLine ctx={ctx4} findOptions={ToolbarSwitcherEntity.findOptions(token => ({ filterOptions: [token(a => a.entity.options).any().append(a => a.toolbarMenu).filter("EqualTo", ctx.value)] }))} />
                        </div>
                    </div>
                </div>
            </CollapsableCard>
            }

            {ctx.value.entityType ?
                <Tabs
                    id="tabs"
                    mountOnEnter
                    unmountOnExit
                    className="mt-2"
                >
                    <Tab eventKey="noEntitySelected" title={ToolbarMessage.No0Selected.niceToString(ctx.value.entityType.toString())} >
                        <ToolbarElementTable ctx={ctx.subCtx(m => m.elements)}
                            withEntity={false}
                            extraColumns={[
                                {
                                    property: (a: ToolbarMenuElementEmbedded) => a.autoSelect,
                                },
                            ]}
                        />
                    </Tab>
                    <Tab eventKey="entitySelected" title={ToolbarMessage.If0Selected.niceToString(ctx.value.entityType.toString())} >
                        <ToolbarElementTable ctx={ctx.subCtx(m => m.elements)}
                            withEntity={true}
                            extraColumns={[
                                {
                                    property: (a: ToolbarMenuElementEmbedded) => a.autoSelect,
                                },
                            ]}
                        />
                    </Tab>

                    <Tab eventKey="all" title={ToolbarMessage.ShowTogether.niceToString()}>
                        <ToolbarElementTable ctx={ctx.subCtx(m => m.elements)}
                            extraColumns={[
                                {
                                    property: (a: ToolbarMenuElementEmbedded) => a.autoSelect,
                                },
                                {
                                    property: (a: ToolbarMenuElementEmbedded) => a.withEntity,
                                },
                            ]}
                        />
                    </Tab>
                </Tabs>
                :
                <ToolbarElementTable ctx={ctx.subCtx(m => m.elements)}
                    extraColumns={[
                        {
                            property: (a: ToolbarMenuElementEmbedded) => a.autoSelect,
                        },
                    ]}
                />
            }
        </div>
    );
}
