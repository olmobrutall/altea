import * as React from "react";
import type { TypeContext } from "./TypeContext";
import { AutoLine } from "./Lines/AutoLine";
import { Dic } from "../entities/globals";

// Signum's AutoComponent: the default view generated when no component is registered for an entity.
// It enumerates the entity's property routes (PropertyRoute.subMembers) and renders an AutoLine per
// member — AutoLine already picks the right editor (ValueLine/EnumLine/EntityLine/EntityCombo/
// EntityDetail/EntityTable/…) from the member's type. The Id member is skipped (it lives in the frame
// header). Wired as the fallback in Navigator.getViewPromise when the type has no registered view.
// Infrastructure fields altea's TypeInfo.fields carries but which are not user-facing properties (unlike
// Signum, whose subMembers omits them): the PK, the new/concurrency flags, and any "_"-prefixed internal
// (e.g. _snapshot, the change-tracking cache).
const SKIP_MEMBERS = new Set(["id", "isNew", "ticks"]);

export default function AutoComponent({ ctx }: { ctx: TypeContext<any>; viewName?: string }): React.ReactNode {
    const members = ctx.propertyRoute!.subMembers();
    const lines = Dic.map(members, name => ctx.subCtx(name))
        .filter(c => {
            const m = c.propertyRoute?.member;
            return m != null && m != "" && !m.startsWith("_") && !SKIP_MEMBERS.has(m);
        })
        .map(c => <AutoLine key={c.propertyPath} ctx={c} />);

    return React.createElement("div", undefined, ...lines);
}

// Lets ViewReplacer-based view overrides apply to the auto-generated view (Signum parity).
(AutoComponent as unknown as { withViewOverrides: boolean }).withViewOverrides = true;
