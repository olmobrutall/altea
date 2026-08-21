import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes, Dic } from "@altea/altea/data/globals";
import { Binding } from "@altea/altea/client/binding";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { Typeahead } from "@altea/altea/client/Components";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { ExpressionOrValueComponent, DesignerModal } from "./Designer";
import { type DesignerNode, type ExpressionOrValue, isExpression } from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import type { HtmlAttributesExpression } from "./HtmlAttributesExpression";

// Port of Signum.Dynamic's View/HtmlAttributesComponent.tsx — verbatim: the inspector row for a node's
// `htmlAttributes`, plus the modal that edits it as two typeahead-driven key/value strips (attributes, then
// CSS properties). The two suggestion LISTS are copied unchanged: they are the vocabulary the typeahead
// offers, and trimming them would just make the editor less helpful.
//
// altea divergence: `LinkButton` → a plain bootstrap `btn btn-link`.

interface HtmlAttributesLineProps {
    binding: Binding<HtmlAttributesExpression | undefined>;
    dn: DesignerNode<BaseNode>;
}

export function HtmlAttributesLine(p: HtmlAttributesLineProps): React.JSX.Element {

    function renderMember(expr: HtmlAttributesExpression | undefined): React.ReactNode {
        return (
            <span className={expr === undefined ? "design-default" : "design-changed"}>
                {p.binding.member}
            </span>);
    }

    function handleRemove(): void {
        p.binding.deleteValue();
        p.dn.context.refreshView();
    }

    function handleCreate(): void {
        modifyExpression({} as HtmlAttributesExpression);
    }

    function handleView(): void {
        const hae = JSON.parse(JSON.stringify(p.binding.getValue())) as HtmlAttributesExpression;
        modifyExpression(hae);
    }

    function modifyExpression(hae: HtmlAttributesExpression): void {

        if (hae.style == undefined)
            hae.style = {};

        void DesignerModal.show("HtmlAttributes", () => <HtmlExpressionComponent dn={p.dn} htmlAttributes={hae} />)
            .then(result => {
                if (result) {
                    if (Object.prototype.hasOwnProperty.call(hae, "style") && Dic.getKeys(hae.style!).length === 0)
                        delete hae.style;

                    if (Dic.getKeys(hae).length === 0)
                        p.binding.deleteValue();
                    else
                        p.binding.setValue(hae);
                }

                p.dn.context.refreshView();
            });
    }

    function getValue(value: unknown): string {
        return isExpression(value) ? "{" + value.__code__ + "}" : String(value);
    }

    function getDescription(hae: HtmlAttributesExpression): string {
        const { style, ...cleanHae } = hae;

        const keys = Dic.map(cleanHae as Record<string, unknown>, (key, value) => key + ":" + getValue(value));

        if (style)
            keys.push("style: {\n"
                + Dic.map(style as Record<string, unknown>, (key, value) => "   " + key + ":" + getValue(value)).join("\n")
                + "\n}");

        return keys.join("\n");
    }

    const val = p.binding.getValue();

    return (
        <div className="form-group form-group-xs">
            <label className="control-label label-xs">
                {renderMember(val)}
                {val && " "}
                {val && <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "sf-remove")}
                    onClick={handleRemove}
                    title={EntityControlMessage.Remove.niceToString()}>
                    <FontAwesomeIcon icon="xmark" />
                </button>}
            </label>
            <div>
                {val
                    ? <button type="button" className="btn btn-link p-0" onClick={handleView}>
                        <pre style={{ padding: "0px", border: "none" }}>{getDescription(val)}</pre>
                    </button>
                    : <button type="button" className="btn btn-link p-0 sf-line-button sf-create"
                        title={EntityControlMessage.Create.niceToString()}
                        onClick={handleCreate}>
                        <FontAwesomeIcon icon="plus" className="sf-create" />&nbsp;{EntityControlMessage.Create.niceToString()}
                    </button>}
            </div>
        </div>
    );
}

export interface HtmlExpressionComponentProps {
    dn: DesignerNode<BaseNode>;
    htmlAttributes: HtmlAttributesExpression;
}

const htmlAttributeList = ["accept", "accept-charset", "accesskey", "action", "align", "alt", "async", "autocomplete", "autofocus", "autoplay", "autosave", "bgcolor", "border",
    "buffered", "challenge", "charset", "checked", "cite", "class", "code", "codebase", "color", "cols", "colspan", "content", "contenteditable", "contextmenu", "controls",
    "coords", "data", "data-*", "datetime", "default", "defer", "dir", "dirname", "disabled", "download", "draggable", "dropzone", "enctype", "for", "form", "formaction",
    "headers", "height", "hidden", "high", "href", "hreflang", "http-equiv", "icon", "id", "ismap", "itemprop", "keytype", "kind", "label", "lang", "language", "list",
    "loop", "low", "manifest", "max", "maxlength", "media", "method", "min", "multiple", "muted", "name", "novalidate", "open", "optimum", "pattern", "ping", "placeholder",
    "poster", "preload", "radiogroup", "readonly", "rel", "required", "reversed", "rows", "rowspan", "sandbox", "scope", "scoped", "seamless", "selected", "shape", "size",
    "sizes", "span", "spellcheck", "src", "srcdoc", "srclang", "srcset", "start", "step", "style", "summary", "tabindex", "target", "title", "type", "usemap", "value", "width",
    "wrap"].sort();

const cssPropertyList = ["color", "opacity", "background", "background-attachment", "background-blend-mode", "background-color", "background-image", "background-position",
    "background-repeat", "background-clip", "background-origin", "background-size", "border", "border-bottom", "border-bottom-color", "border-bottom-left-radius",
    "border-bottom-right-radius", "border-bottom-style", "border-bottom-width", "border-color", "border-image", "border-image-outset", "border-image-repeat",
    "border-image-slice", "border-image-source", "border-image-width", "border-left", "border-left-color", "border-left-style", "border-left-width", "border-radius",
    "border-right", "border-right-color", "border-right-style", "border-right-width", "border-style", "border-top", "border-top-color", "border-top-left-radius",
    "border-top-right-radius", "border-top-style", "border-top-width", "border-width", "box-decoration-break", "box-shadow", "bottom", "clear", "clip", "display", "float",
    "height", "left", "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "max-height", "max-width", "min-height", "min-width", "overflow",
    "overflow-x", "overflow-y", "padding", "padding-bottom", "padding-left", "padding-right", "padding-top", "position", "right", "top", "visibility", "width", "vertical-align",
    "z-index", "align-content", "align-items", "align-self", "flex", "flex-basis", "flex-direction", "flex-flow", "flex-grow", "flex-shrink", "flex-wrap", "justify-content",
    "order", "hanging-punctuation", "hyphens", "letter-spacing", "line-break", "line-height", "overflow-wrap", "tab-size", "text-align", "text-align-last", "text-combine-upright",
    "text-indent", "text-justify", "text-transform", "white-space", "word-break", "word-spacing", "word-wrap", "text-decoration", "text-decoration-color", "text-decoration-line",
    "text-decoration-style", "text-shadow", "text-underline-position", "@font-face", "@font-feature-values", "font", "font-family", "font-feature-settings", "font-kerning",
    "font-language-override", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-synthesis", "font-variant", "font-variant-alternates", "font-variant-caps",
    "font-variant-east-asian", "font-variant-ligatures", "font-variant-numeric", "font-variant-position", "font-weight", "direction", "text-orientation",
    "unicode-bidi", "writing-mode", "border-collapse", "border-spacing", "caption-side", "empty-cells", "table-layout", "counter-increment", "counter-reset", "list-style",
    "list-style-image", "list-style-position", "list-style-type", "@keyframes", "animation", "animation-delay", "animation-direction", "animation-duration", "animation-fill-mode",
    "animation-iteration-count", "animation-name", "animation-play-state", "animation-timing-function", "backface-visibility", "perspective", "perspective-origin", "transform",
    "transform-origin", "transform-style", "transition", "transition-property", "transition-duration", "transition-timing-function", "transition-delay", "box-sizing", "content",
    "cursor", "ime-mode", "nav-down", "nav-index", "nav-left", "nav-right", "nav-up", "outline", "outline-color", "outline-offset", "outline-style", "outline-width", "resize",
    "text-overflow", "break-after", "break-before", "break-inside", "column-count", "column-fill", "column-gap", "column-rule", "column-rule-color", "column-rule-style",
    "column-rule-width", "column-span", "column-width", "columns", "widows", "orphans", "page-break-after", "page-break-before", "page-break-inside", "marks", "quotes", "filter",
    "image-orientation", "image-rendering", "image-resolution", "object-fit", "object-position", "mask", "mask-type", "mark", "mark-after", "mark-before", "phonemes", "rest",
    "rest-after", "rest-before", "voice-balance", "voice-duration", "voice-pitch", "voice-pitch-range", "voice-rate", "voice-stress", "voice-volume", "marquee-direction",
    "marquee-play-count", "marquee-speed", "marquee-style"].sort();

export function HtmlExpressionComponent(p: HtmlExpressionComponentProps): React.JSX.Element {
    return (
        <div className="form-sm code-container">
            <fieldset>
                <legend>HTML Attributes</legend>
                <ExpressionOrValueStrip object={p.htmlAttributes as Record<string, ExpressionOrValue<unknown>>}
                    filterKey={key => key !== "style"} dn={p.dn} possibleKeys={htmlAttributeList} />
                <fieldset>
                    <legend>CSS Properties</legend>
                    <ExpressionOrValueStrip object={p.htmlAttributes.style as Record<string, ExpressionOrValue<unknown>>}
                        filterKey={() => true} dn={p.dn} possibleKeys={cssPropertyList} />
                </fieldset>
            </fieldset>
        </div>
    );
}

export interface ExpressionOrValueStripProps {
    possibleKeys: string[];
    dn: DesignerNode<BaseNode>;
    object: Record<string, ExpressionOrValue<unknown>>;
    filterKey: (key: string) => boolean;
}

export function ExpressionOrValueStrip(p: ExpressionOrValueStripProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    function handleOnRemove(key: string): void {
        delete p.object[key];
        forceUpdate();
    }

    function handleGetItems(query: string): Promise<string[]> {
        const result = p.possibleKeys
            .filter(k => k.toLowerCase().includes(query.toLowerCase())
                && !Object.prototype.hasOwnProperty.call(p.object, k))
            .sort((a, b) => a.length - b.length)
            .slice(0, 5);

        return Promise.resolve(result);
    }

    function handleSelect(item: unknown): string {
        p.object[item as string] = undefined as never;
        forceUpdate();
        return "";
    }

    return (
        <div>
            <ul className="expression-list">
                {Dic.getKeys(p.object).filter(p.filterKey).map(key =>
                    <li key={key}>
                        <button type="button" className="btn btn-link p-0 sf-line-button sf-remove"
                            onClick={() => handleOnRemove(key)}
                            title={EntityControlMessage.Remove.niceToString()}>
                            <FontAwesomeIcon icon="xmark" />
                        </button>
                        <ExpressionOrValueComponent dn={p.dn} refreshView={forceUpdate}
                            binding={new Binding(p.object, key)} type="string" defaultValue={null} avoidDelete={true} />
                    </li>)}
            </ul>
            <Typeahead
                inputAttrs={{ className: "form-control form-control-xs sf-entity-autocomplete" }}
                getItems={handleGetItems}
                onSelect={handleSelect} />
        </div>
    );
}
