import type * as React from "react";
import type { BaseEntity } from "@altea/altea/data/entity";
import { classes, Dic } from "@altea/altea/data/globals";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { ExpressionOrValue } from "./NodeUtils";
import * as NodeUtils from "./NodeUtils";

// Port of Signum.Dynamic's View/HtmlAttributesExpression.tsx — verbatim: the stored, EXPRESSION-capable twin
// of a React `HTMLAttributes` bag, and the functions that resolve it against a live context.
//
// altea divergence: `String.prototype.firstUpper` is a Signum global; spelled out here.
export interface HtmlAttributesExpression {
    style?: CssPropertiesExpression;
    [key: string]: ExpressionOrValue<unknown>;
}

export interface CssPropertiesExpression {
    [key: string]: ExpressionOrValue<unknown>;
}

export function toHtmlAttributes(
    dn: unknown,
    parentCtx: TypeContext<BaseEntity>,
    hae: HtmlAttributesExpression | undefined,
): React.HTMLAttributes<unknown> | undefined {
    if (hae == undefined)
        return undefined;

    const result: Record<string, unknown> = {};
    Dic.getKeys(hae).filter(k => k !== "style").forEach(key =>
        result[toPascal(key)] = NodeUtils.evaluateUntyped(dn, parentCtx, hae[key], () => key));

    if (hae.style)
        result["style"] = toCssProperties(dn, parentCtx, hae.style);

    return result as React.HTMLAttributes<unknown>;
}

export function withClassName(
    attrs: React.HTMLAttributes<unknown> | undefined,
    className: string,
): React.HTMLAttributes<unknown> {
    if (attrs == undefined)
        return { className: className };

    attrs.className = classes(className, attrs.className);

    return attrs;
}

export function toCssProperties(
    dn: unknown,
    parentCtx: TypeContext<BaseEntity>,
    cpe: CssPropertiesExpression,
): React.CSSProperties {

    const result: Record<string, unknown> = {};
    Dic.getKeys(cpe).forEach(key =>
        result[toPascal(key)] = NodeUtils.evaluateUntyped(dn, parentCtx, cpe[key], () => key));
    return result as React.CSSProperties;
}

export function toPascal(dashedName: string): string {
    if (dashedName === "class")
        return "className";

    if (dashedName === "for")
        return "htmlFor";

    return dashedName.split("-")
        .map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
}
