import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { classes } from "@altea/altea/data/globals";
import { HelpMessage } from "../../data/Help";

// Port of Signum.Help's Editor/EditableText.tsx — a plain-text field that renders as TEXT until you press
// its pencil, then as a TextAreaLine. Used for the two short fields (a namespace's title, an appendix's
// title and unique name). Verbatim apart from altea's import paths.
export function EditableText({ ctx, defaultText, onChange, defaultEditable }: {
    ctx: TypeContext<string | null>;
    defaultText?: string;
    onChange?: () => void;
    defaultEditable?: boolean;
}): React.JSX.Element {

    const [editable, setEditable] = React.useState(defaultEditable ?? false);
    const forceUpdate = useForceUpdate();

    return (
        <span className="sf-edit-container">
            {editable
                ? <TextAreaLine ctx={ctx}
                    formGroupStyle="SrOnly"
                    onChange={() => { forceUpdate(); onChange?.(); }}
                    valueHtmlAttributes={{ placeholder: defaultText ?? ctx.niceName() }}
                    formGroupHtmlAttributes={{ style: { display: "inline-block" } }} />
                : ctx.value ? <span>{ctx.value}</span>
                    : defaultText ? <span>{defaultText}</span>
                        : <span className="sf-no-text">[{ctx.niceName()}]</span>}

            {!ctx.readOnly &&
                <LinkButton className={classes("sf-edit-button", editable && "active")}
                    title={(editable ? HelpMessage.Close : HelpMessage.Edit).niceToString()}
                    onClick={() => setEditable(!editable)}>
                    <FontAwesomeIcon icon={editable ? "xmark" : "pen-to-square"} className="ms-2" aria-hidden={true} />
                    {" "}{(editable ? HelpMessage.Close : HelpMessage.Edit).niceToString()}
                </LinkButton>}
        </span>
    );
}
