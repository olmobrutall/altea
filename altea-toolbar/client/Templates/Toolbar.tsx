import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { TypeInfo } from "@altea/altea/data/reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import { Enum } from "@altea/altea/data/enum";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable, type EntityTableColumn } from "@altea/altea/client/Lines/EntityTable";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Constructor } from "@altea/altea/client/Constructor";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarElementTypeEnum, ShowCountEnum,
    type ToolbarElementBaseEntity, type ToolbarMenuEntity_Element, type ShowCount,
} from "../../data/Toolbar";
import { ToolbarClient } from "../ToolbarClient";
import { ToolbarCount } from "../QueryToolbarConfig";

// Faithful port of Signum's Templates/Toolbar.tsx (Signum.Toolbar/Templates/Toolbar.tsx): the Toolbar editor
// plus the shared ELEMENT TABLE both it and the ToolbarMenu editor use.
//
// altea divergences:
//  - The element table is generic over the row type (`ToolbarEntity_Element` for a Toolbar,
//    `ToolbarMenuEntity_Element` for a ToolbarMenu) because altea splits Signum's one ToolbarElementEmbedded into two
//    per-owner @part rows (see data/Toolbar.ts). Signum could type it as the base since the subclass shared
//    its table.
//  - `New(type, {…})` (Signum's untyped factory over a clean name) → `Constructor.construct(ctor, props)`;
//    the row ctor comes from the collection's PropertyRoute, so the right row type is created for each owner.
//  - `ctx.propertyRoute!.typeReference()!.name` → the route's `fieldInfo` / `memberType` (altea's ONE
//    TypeReference), read through `ctx.memberInfo(...)`.

export default function Toolbar(p: { ctx: TypeContext<ToolbarEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx3 = ctx.subCtx({ labelColumns: 3 });
    return (
        <div>
            <div className="row">
                <div className="col-sm-7">
                    <AutoLine ctx={ctx3.subCtx(f => f.name)} />
                    <EntityLine ctx={ctx3.subCtx(e => e.owner)} />
                </div>

                <div className="col-sm-5">
                    <AutoLine ctx={ctx3.subCtx(f => f.location)} />
                    <AutoLine ctx={ctx3.subCtx(e => e.priority)} />
                </div>
            </div>
            <ToolbarElementTable ctx={ctx3.subCtx(a => a.elements)} />
        </div>
    );
}

/** Signum's `getDefaultIcon(ti)`: the icon shown next to a content TYPE in the "what should this element point
 *  at?" selector — the toolbar's own four are hard-coded, everything else asks the registered config. */
function getDefaultIcon(ti: TypeInfo): IconProp | null {

    if (cleanTypeName(ti.ctor!) == cleanTypeName(ToolbarEntity))
        return "bars-staggered";

    if (cleanTypeName(ti.ctor!) == cleanTypeName(ToolbarMenuEntity))
        return "bars";

    if (cleanTypeName(ti.ctor!) == cleanTypeName(ToolbarSwitcherEntity))
        return "square-caret-down";

    if (cleanTypeName(ti.ctor!) == cleanTypeName(PermissionSymbol))
        return "key";

    const conf = ToolbarClient.configs()[cleanTypeName(ti.ctor!)];
    if (conf == null || conf.length == 0)
        return null;

    return conf.first().getDefaultIcon();
}

export function ToolbarElementTable<R extends ToolbarElementBaseEntity>({ ctx, extraColumns, withEntity }: {
    ctx: TypeContext<R[]>,
    extraColumns?: (EntityTableColumn<R, unknown> | null | undefined)[],
    withEntity?: boolean,
}): React.JSX.Element {

    function selectContentType(filter: (ti: TypeInfo) => boolean): Promise<TypeInfo | undefined> {
        const pr = ctx.memberInfo(ml => ml[0].content);
        return SelectorModal.chooseType(pr!.typeInfos().filter(filter), {
            size: "def" as any,
            buttonDisplay: ti => {
                const icon = getDefaultIcon(ti);

                if (icon == null)
                    return ti.getNiceName();

                return <><FontAwesomeIcon aria-hidden={true} icon={icon} /><span className="ms-2">{ti.getNiceName()}</span></>;
            },
        });
    }

    return (
        <EntityTable ctx={ctx} view
            filterRows={withEntity == undefined ? undefined : ctxs => ctxs.filter(a => (a.value as unknown as ToolbarMenuEntity_Element).withEntity === withEntity)}
            // Signum: `New(type, { type: "Item", withEntity })`. The row ctor comes from the collection's own
            // PropertyRoute, so a Toolbar gets a ToolbarEntity_Element and a ToolbarMenu a ToolbarMenuElement.
            onCreate={pr => Constructor.construct(pr.fieldInfo!.getFunction()!.name, {
                type: ToolbarElementTypeEnum.Item,
                withEntity,
            }) as Promise<R | undefined>}
            columns={[
                {
                    header: "Icon",
                    headerHtmlAttributes: { style: { width: "5%" } },
                    template: ctx => {
                        const icon = parseIcon(ctx.value.iconName);
                        const bgColor = (ctx.value.iconColor && ctx.value.iconColor.toLowerCase() == "var(--bs-body-bg)" ? "var(--bs-body-color)" : undefined);
                        return icon && <div>
                            <FontAwesomeIcon icon={fallbackIcon(icon)} style={{ backgroundColor: bgColor, color: ctx.value.iconColor ?? undefined, fontSize: "25px" }} />
                            {ctx.value.showCount && <ToolbarCount showCount={showCountName(ctx.value)} num={showCountName(ctx.value) == "Always" ? 0 : 1} />}
                        </div>;
                    },
                },
                { property: a => a.type, headerHtmlAttributes: { style: { width: "15%" } }, template: (ctx, row) => <AutoLine ctx={ctx.subCtx(a => a.type)} onChange={() => { row.forceUpdate(); }} /> },
                {
                    property: a => a.content, headerHtmlAttributes: { style: { width: "30%" } }, template: ctx => <EntityLine ctx={ctx.subCtx(a => a.content)}
                        onFind={() => selectContentType(ti => Navigator.isFindable(cleanTypeName(ti.ctor!))).then(ti => ti && Finder.find({ queryName: cleanTypeName(ti.ctor!) }))}
                        onCreate={() => selectContentType(ti => Navigator.isCreable(cleanTypeName(ti.ctor!))).then(ti => ti && Constructor.construct(cleanTypeName(ti.ctor!)) as Promise<Entity>)}
                    />,
                },
                { property: a => a.label, headerHtmlAttributes: { style: { width: "25%" } }, template: ctx => <AutoLine ctx={ctx.subCtx(a => a.label)} /> },
                { property: a => a.url, headerHtmlAttributes: { style: { width: "25%" } }, template: ctx => <AutoLine ctx={ctx.subCtx(a => a.url)} /> },
                ...(extraColumns ?? []),
            ]} />
    );
}

/** An element's `showCount` as its member NAME: the stored value is the enum ordinal, but the ToolbarCount
 *  badge speaks the wire form (like the rest of the client), so the conversion happens here. */
function showCountName(e: ToolbarElementBaseEntity): ShowCount {
    return Enum.toName(ShowCountEnum, e.showCount!);
}
