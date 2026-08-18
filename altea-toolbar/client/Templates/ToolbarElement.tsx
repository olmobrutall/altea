import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Enum } from "@altea/altea/data/enum";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { parseIcon } from "@altea/altea/client/Components/IconHelpers";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import {
    ToolbarElementTypeEnum, ShowCountEnum, type ToolbarElementBaseEntity, type ShowCount,
} from "../../data/Toolbar";
import { ToolbarCount } from "../QueryToolbarConfig";

// Faithful port of Signum's Templates/ToolbarElement.tsx (Signum.Toolbar/Templates/ToolbarElement.tsx): the
// per-element detail editor (the row's "view" popup) — what it points at, its icon / color / label, and the
// count + popup options a query-ish content unlocks.
//
// altea divergences:
//  - `IconTypeaheadLine` → a plain `TextBoxLine` (altea has no IconTypeahead component; the stored format is
//    identical, see IconHelpers.parseIcon). Same substitution the dashboard editor made.
//  - `content.EntityType == "UserQuery"` (a clean-name string) → `cleanTypeName(content.entityType)`.
//  - `a.modified = true` (Signum's manual dirty flag) is dropped: altea tracks dirtiness by snapshot.

export default function ToolbarElement(p: { ctx: TypeContext<ToolbarElementBaseEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    function handleTypeChanges(): void {
        const a = p.ctx.value;
        fixToolbarElementType(a);
        forceUpdate();
    }

    function handleContentChange(): void {
        const tbe = p.ctx.value;
        if (tbe.content && tbe.content.entityType !== PermissionSymbol) {
            tbe.url = null;
        }
        forceUpdate();
    }

    const ctx = p.ctx;

    const ctx4 = ctx.subCtx({ labelColumns: 4 });
    const ctx2 = ctx.subCtx({ labelColumns: 2 });
    const ctx6 = ctx.subCtx({ labelColumns: 6 });
    const bgColor = (ctx4.value.iconColor && ctx4.value.iconColor.toLowerCase() == "var(--bs-body-bg)" ? "var(--bs-body-color)" : undefined);

    const content = ctx2.value.content;
    const type = Enum.toName(ToolbarElementTypeEnum, ctx.value.type);
    // Signum tests `content.EntityType == "UserQuery" || "Query"`: the two contents that RUN a query, and so
    // can show a count / open in a popup. A UserQuery only exists when altea-user-queries is registered, so
    // the check stays name-based (the toolbar module must not depend on it).
    const isQueryish = content != null && ["Query", "UserQuery"].includes(cleanTypeName(content.entityType));

    const icon = parseIcon(ctx4.value.iconName);

    return (
        <div>
            <div className="row">
                <div className="col-sm-5">
                    <AutoLine ctx={ctx4.subCtx(t => t.type)} onChange={handleTypeChanges} />
                </div>
                <div className="col-sm-5 offset-sm-1">
                    {type != "Divider" && <EntityLine ctx={ctx2.subCtx(t => t.content)} onChange={handleContentChange} />}
                </div>
            </div>

            {type != "Divider" &&
                <div className="row">
                    <div className="col-sm-5">
                        <TextBoxLine ctx={ctx4.subCtx(t => t.iconName)} onChange={() => forceUpdate()} />
                        <AutoLine ctx={ctx4.subCtx(t => t.iconColor)} onChange={() => forceUpdate()} />
                        {isQueryish && <AutoLine ctx={ctx4.subCtx(a => a.showCount)} onChange={() => forceUpdate()} />}
                    </div>
                    <div className="col-sm-1">
                        {icon && <div style={{ marginTop: "17px" }}>
                            <FontAwesomeIcon icon={icon} style={{ backgroundColor: bgColor, color: ctx4.value.iconColor || undefined, fontSize: "25px" }} />
                            {ctx.value.showCount && <ToolbarCount showCount={showCountName(ctx.value)} num={showCountName(ctx.value) == "Always" ? 0 : 1} />}
                        </div>
                        }
                    </div>
                    <div className="col-sm-5">
                        <TextBoxLine ctx={ctx2.subCtx(t => t.label)} valueHtmlAttributes={{ placeholder: content?.toString() || undefined }} />
                        {(type == "Header" || type == "Item") && (content == null || content.entityType === PermissionSymbol) && <AutoLine ctx={ctx2.subCtx(t => t.url)} />}
                        {isQueryish &&
                            <div>
                                <AutoLine ctx={ctx6.subCtx(t => t.openInPopup)} />
                                <AutoLine ctx={ctx6.subCtx(t => t.autoRefreshPeriod)} />
                            </div>
                        }
                    </div>
                </div>
            }
        </div>
    );
}

/** Signum's `fixToolbarElementType`: a Divider carries nothing, so clear the four members when the type
 *  changes to it (the data-layer validation enforces the same rule). */
function fixToolbarElementType(a: ToolbarElementBaseEntity): void {
    if (Enum.toName(ToolbarElementTypeEnum, a.type) == "Divider") {
        a.iconName = null;
        a.content = null;
        a.label = null;
        a.url = null;
    }
}

function showCountName(e: ToolbarElementBaseEntity): ShowCount {
    return Enum.toName(ShowCountEnum, e.showCount!);
}
