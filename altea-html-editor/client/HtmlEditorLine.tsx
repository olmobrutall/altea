import * as React from "react";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { classes } from "@altea/altea/data/globals";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import HtmlEditor, { type HtmlEditorProps } from "./HtmlEditor";
import type { HtmlEditorController } from "./HtmlEditorController";
import "./HtmlEditorLine.css";

// Port of Signum.HtmlEditor's HtmlEditorLine.tsx — the editor as a LINE: a FormGroup around it, bound to a
// TypeContext's string field, with optional extra buttons on either side.
//
// altea divergences:
//  - `getTimeMachineIcon` is not ported (altea has no TimeMachine module), so the icon slot is dropped.
//  - the mandatory highlight reads `ctx.propertyRoute?.member?.required` in Signum; altea's FieldInfo has no
//    `required` flag — a non-nullable field gets an IMPLICIT NotNull validator instead — so the fallback is
//    `!ctx.value` combined with the caller's explicit `mandatory` prop, and the FormGroup already shows the
//    validation error.
export interface HtmlEditorLineProps extends Omit<HtmlEditorProps, "binding"> {
    ctx: TypeContext<string | null | undefined>;
    labelIcon?: React.ReactNode;
    htmlEditorRef?: React.Ref<HtmlEditorController>;
    extraButtons?: () => React.ReactNode;
    extraButtonsBefore?: () => React.ReactNode;
}

export default function HtmlEditorLine({
    ctx, htmlEditorRef, readOnly, extraButtons, extraButtonsBefore, ...p
}: HtmlEditorLineProps): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    return (
        <FormGroup ctx={ctx} labelIcon={p.labelIcon}>
            {() => (
                <ErrorBoundary>
                    <div className="d-flex">
                        {extraButtonsBefore && (
                            <div className={ctx.inputGroupVerticalClass("before")}>
                                {extraButtonsBefore()}
                            </div>
                        )}
                        <div
                            className={classes("html-editor-line", p.mandatory && !ctx.value && "sf-mandatory")}
                            style={{
                                backgroundColor: (readOnly ?? ctx.readOnly) ? "var(--bs-secondary-bg)" : undefined,
                                flexGrow: 1,
                                ...p.htmlAttributes?.style,
                            }}
                            data-property-path={ctx.propertyPath}
                        >
                            <HtmlEditor
                                readOnly={readOnly ?? ctx.readOnly}
                                binding={ctx.binding}
                                ref={htmlEditorRef}
                                {...p}
                                onEditorBlur={(e, controller) => {
                                    forceUpdate();
                                    p.onEditorBlur?.(e, controller);
                                }}
                            />
                        </div>
                        {extraButtons && (
                            <div className={ctx.inputGroupVerticalClass("after")}>
                                {extraButtons()}
                            </div>
                        )}
                    </div>
                </ErrorBoundary>
            )}
        </FormGroup>
    );
}
