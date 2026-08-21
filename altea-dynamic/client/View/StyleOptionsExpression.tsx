import type { BaseEntity } from "@altea/altea/data/entity";
import type { TypeContext, StyleOptions, FormGroupStyle, FormSize } from "@altea/altea/client/TypeContext";
import type { ExpressionOrValue } from "./NodeUtils";
import * as NodeUtils from "./NodeUtils";

// Port of Signum.Dynamic's View/StyleOptionsExpression.tsx — verbatim: the stored, EXPRESSION-capable twin
// of altea's `StyleOptions`, and the two functions that resolve it against a live context.
//
// altea note: the stored field is passed to `subCtx` AS A STRING. altea's string overload parses a field
// PATH (dotted paths included), so it covers what Signum's lambda did — and a runtime-built lambda would
// NOT work here, because altea resolves a lambda through the `__quoted` tree the transformer stamps.
export interface StyleOptionsExpression {
    formGroupStyle?: ExpressionOrValue<FormGroupStyle>;
    formSize?: ExpressionOrValue<FormSize>;
    placeholderLabels?: ExpressionOrValue<boolean>;
    readonlyAsPlainText?: ExpressionOrValue<boolean>;
    labelColumns?: ExpressionOrValue<number>;
    valueColumns?: ExpressionOrValue<number>;
    readOnly?: ExpressionOrValue<boolean>;
}

export const formSize: FormSize[] = ["xs", "sm", "md", "lg"];
export const formGroupStyle: FormGroupStyle[] = ["None", "Basic", "BasicDown", "SrOnly", "LabelColumns"];

export function subCtx(
    dn: unknown,
    ctx: TypeContext<BaseEntity>,
    field: string | undefined,
    soe: StyleOptionsExpression | undefined,
): TypeContext<unknown> {
    if (field == undefined && soe == undefined)
        return ctx;

    if (field == undefined)
        return ctx.subCtx(toStyleOptions(dn, ctx, soe)!);

    return ctx.subCtx(field, toStyleOptions(dn, ctx, soe));
}

export function toStyleOptions(
    dn: unknown,
    ctx: TypeContext<BaseEntity>,
    soe: StyleOptionsExpression | undefined,
): StyleOptions | undefined {

    if (soe == undefined)
        return undefined;

    return {
        formGroupStyle: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.formGroupStyle, val => NodeUtils.isInListOrNull(val, formGroupStyle)),
        formSize: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.formSize, val => NodeUtils.isInListOrNull(val, formSize)),
        placeholderLabels: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.placeholderLabels, NodeUtils.isBooleanOrNull),
        readonlyAsPlainText: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.readonlyAsPlainText, NodeUtils.isBooleanOrNull),
        labelColumns: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.labelColumns, NodeUtils.isNumberOrNull),
        valueColumns: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.valueColumns, NodeUtils.isNumberOrNull),
        readOnly: NodeUtils.evaluateAndValidate(dn, ctx, soe, s => s.readOnly, NodeUtils.isBooleanOrNull),
    } as StyleOptions;
}
