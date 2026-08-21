import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { toInt } from "@altea/altea/data/basics";
import type { Pop3EmailReceptionServiceEntity } from "../../data/MailingPop3";

// Port of Signum.Mailing.Pop3's Pop3EmailReceptionService.tsx.
//
// altea divergence: Signum's `EnableSSL` SETTER flips the port between 995 and 110. altea entities have no
// property setters, so the flip happens HERE, where the user can see it — and only when the box is toggled,
// so a deliberately unusual port is not overwritten on every deserialization (which the setter would do).
export default function Pop3EmailReceptionService(p: { ctx: TypeContext<Pop3EmailReceptionServiceEntity> }): React.JSX.Element {
    const sc = p.ctx;
    const forceUpdate = useForceUpdate();

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.host)} />
            <CheckboxLine ctx={sc.subCtx(s => s.enableSSL)} onChange={() => {
                // Signum's setter: the conventional POP3S / POP3 ports. No "mark modified" needed — altea
                // tracks changes by diffing against a snapshot, so the write itself is the change.
                sc.value.port = toInt(sc.value.enableSSL ? 995 : 110);
                forceUpdate();
            }} />
            <AutoLine ctx={sc.subCtx(s => s.port)} />
            <AutoLine ctx={sc.subCtx(s => s.username)} />
            <AutoLine ctx={sc.subCtx(s => s.password, { readOnly: true })} />
            <AutoLine ctx={sc.subCtx(s => s.newPassword)} />
            <AutoLine ctx={sc.subCtx(s => s.readTimeout)} />
            <EntityRepeater ctx={sc.subCtx(s => s.clientCertificationFiles)} />
        </div>
    );
}
