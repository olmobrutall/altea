import * as React from "react";
import type { Options } from "react-markdown";
import Markdown from "react-markdown";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorBoundary } from "@altea/altea/client/Components/ErrorBoundary";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { TextAreaLine, type TextAreaLineProps } from "@altea/altea/client/Lines/TextAreaLine";
import { MarkdownMessage } from "../data/Markdown";

// Port of Signum.Markdown's MarkdownLine.tsx — a text area over a markdown string, with a syntax cheat-sheet
// popover on the label and a toggle that swaps the editor for the rendered result. Read-only starts in
// preview, and follows `ctx.readOnly` if that changes underneath.
//
// ALTEA divergences:
//  - **`markdownOption` is actually APPLIED.** Signum declares the prop and never reads it — its `<Markdown>`
//    call passes only the children — so a caller asking for custom components or remark plugins silently got
//    the defaults. Same shape as the `controller.editorState` bug @altea/altea-html-editor fixes rather than
//    mirrors: a declared prop that does nothing is a bug, not a behaviour to preserve.
//  - the cheat-sheet rows are the same eight Signum lists, but their left column is the literal markdown and
//    the right column renders it through `<Markdown>` rather than being hand-written HTML — so the table
//    cannot drift from what the editor actually does.
export interface MarkdownLineProps extends TextAreaLineProps {
    markdownOption?: Options;
}

// The syntax the popover documents — Signum's eight rows, verbatim.
const syntaxRows = ["**bold**", "*italic*", "# H1", "## H2", "[text](url)", "- item", "`code`", "---"];

// …rendered through the real renderer, but flattened for a table cell: a `<p>` would add a margin and an
// `<h1>` would be twice the popover's own font size. Signum hand-wrote `<strong>H1</strong>` for that reason;
// mapping the elements keeps its look without letting the cheat sheet drift from what the editor does.
const compactComponents = {
    p: (p: { children?: React.ReactNode }) => <>{p.children}</>,
    h1: (p: { children?: React.ReactNode }) => <strong>{p.children}</strong>,
    h2: (p: { children?: React.ReactNode }) => <strong>{p.children}</strong>,
    ul: (p: { children?: React.ReactNode }) => <span>{p.children}</span>,
    li: (p: { children?: React.ReactNode }) => <>{p.children}</>,
};

export function MarkdownLine({ ctx, markdownOption, readOnly, label, valueHtmlAttributes, helpTextOnTop, ...p }: MarkdownLineProps): React.JSX.Element {
    const [preview, setPreview] = React.useState(ctx.readOnly);

    // `helpTextOnTop` may be a function of the controller (altea's LineBaseProps, as Signum's); this component
    // renders the FormGroup itself and has no controller to hand it, so only the plain form is forwarded.
    const helpTextOnTopResolved: React.ReactNode = typeof helpTextOnTop == "function" ? undefined : helpTextOnTop;

    React.useEffect(() => {
        setPreview(ctx.readOnly);
    }, [ctx.readOnly]);

    const markdownHelp = (
        <OverlayTrigger trigger="click" placement="top" rootClose overlay={
            <Popover id="markdown-syntax-popover">
                <Popover.Header>Markdown Syntax</Popover.Header>
                <Popover.Body>
                    <table className="table table-sm table-borderless mb-0" style={{ fontSize: "0.8em" }}>
                        <tbody>
                            {syntaxRows.map(s => <tr key={s}>
                                <td><code>{s}</code></td>
                                <td><Markdown components={compactComponents}>{s}</Markdown></td>
                            </tr>)}
                        </tbody>
                    </table>
                </Popover.Body>
            </Popover>
        }>
            <span className="ms-1 me-1" style={{ cursor: "pointer", color: "var(--bs-secondary)" }}>
                <FontAwesomeIcon aria-hidden={true} icon={["fab", "markdown"]} />
            </span>
        </OverlayTrigger>
    );

    const toggle = (
        <LinkButton className="ms-1"
            title={(preview ? MarkdownMessage.Edit0 : MarkdownMessage.Preview0).niceToString(ctx.niceName())}
            onClick={() => setPreview(a => !a)}>
            <FontAwesomeIcon aria-hidden={true} icon={preview ? "edit" : "eye"} />
        </LinkButton>
    );

    return (
        <ErrorBoundary>
            <FormGroup ctx={ctx} label={<>{markdownHelp}{label ?? ctx.niceName()}</>} labelIcon={toggle} helpTextOnTop={helpTextOnTopResolved}>
                {() => preview ? <div className="form-control form-control-sm"><Markdown {...markdownOption}>{ctx.value}</Markdown></div> :
                    <TextAreaLine
                        ctx={ctx.subCtx({ formGroupStyle: "None" })}
                        readOnly={readOnly}
                        {...p}
                        valueHtmlAttributes={{
                            ...valueHtmlAttributes,
                            style: { minHeight: 80, ...valueHtmlAttributes?.style },
                        }} />}
            </FormGroup>
        </ErrorBoundary>
    );
}
