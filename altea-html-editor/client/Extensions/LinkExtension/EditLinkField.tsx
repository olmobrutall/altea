import * as React from "react";
import { classes } from "@altea/altea/data/globals/helpers";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityBaseController } from "@altea/altea/client/Lines/EntityBase";
import type { AutoLineProps } from "@altea/altea/client/Lines/AutoLine";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { HtmlEditorMessage } from "../../../data/HtmlEditor";

// The url field AutoLineModal hosts for the link toolbar button: a text box plus a clear button, which sets
// the value to null so an empty OK unlinks.
export default function EditLinkField(p: AutoLineProps): React.ReactNode {
    const forceUpdate = useForceUpdate();
    return (
        <TextBoxLine {...p}
            valueHtmlAttributes={{ placeholder: HtmlEditorMessage.EnterYourUrlHere.niceToString() }}
            extraButtons={() =>
                <LinkButton className={classes("sf-line-button", "sf-remove", "input-group-text")}
                    onClick={() => { p.ctx.value = null; forceUpdate(); }}
                    title={EntityControlMessage.Remove.niceToString()}>
                    {EntityBaseController.getRemoveIcon()}
                </LinkButton>} />
    );
}
