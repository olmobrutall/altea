import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { NoteEntity } from "../../data/Notes";

// Port of Signum.Notes/Templates/Note.tsx — who wrote it and when (read-only, once saved), what it hangs
// off, then the editable half.
export default function Note(p: { ctx: TypeContext<NoteEntity> }): React.JSX.Element {
    const ec = p.ctx.subCtx({ labelColumns: { sm: 2 } });

    return (
        <div>
            {!ec.value.isNew &&
                <div>
                    <EntityLine ctx={ec.subCtx(n => n.createdBy)} readOnly={true} />
                    <AutoLine ctx={ec.subCtx(n => n.creationDate)} readOnly={true} />
                </div>}
            <EntityLine ctx={ec.subCtx(n => n.target)} readOnly={true} />
            <hr />
            <AutoLine ctx={ec.subCtx(n => n.title)} />
            <EntityCombo ctx={ec.subCtx(n => n.noteType)} />
            <TextAreaLine ctx={ec.subCtx(n => n.text)} valueHtmlAttributes={{ style: { height: "180px" } }} />
        </div>
    );
}
