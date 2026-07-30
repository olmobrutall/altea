// Ported from Signum.React/Lines/MultiValueLine.tsx. Like Signum it extends LineBaseController directly
// (NOT EntityListBase — it's a minimal add-blank / remove / inline-edit list, and its `onCreate`
// returns VALUES, not rows). altea twist: the collection is `R[]` of ROW entities each carrying the
// scalar on its @valueField (Signum stored the scalar directly in the MList). So each element edits
// its row's @valueField sub-context via AutoLine; "add" creates a new row wrapping the value
// (`RowType.create({ [valueField]: value })`), "remove" drops the row. `memberType.valueField()`
// resolves the @valueField at runtime (throws if the row type declares none — this is a value line).
import * as React from "react";
import { TypeContext } from "../TypeContext";
import { mlistItemContext } from "../TypeContext";
import { FormGroup } from "./FormGroup";
import { AutoLine, type AutoLineProps } from "./AutoLine";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorBoundary } from "../Components";
import { EntityBaseController } from "./EntityBase";
import { type LineBaseProps, LineBaseController, useController, genericMemo } from "./LineBase";
import { classes, KeyGenerator } from "../../entities/globals";
import { BaseEntity } from "../../entities/entity";
import { type FieldInfo } from "../../entities/reflection";
import { SearchMessage } from "../../entities/uiMessages";
import { LinkButton } from "../Basics/LinkButton";

interface MultiValueLineProps<R extends BaseEntity> extends LineBaseProps<R[]> {
  onRenderItem?: (p: AutoLineProps) => React.ReactElement;
  onCreate?: () => Promise<any[] | any | undefined>;
  addValueText?: string;
  valueColumClass?: string;
  filterRows?: (ctxs: TypeContext<R>[]) => TypeContext<R>[];
  ref?: React.Ref<MultiValueLineController<R>>;
}

export class MultiValueLineController<R extends BaseEntity> extends LineBaseController<MultiValueLineProps<R>, R[]> {

  keyGenerator: KeyGenerator = new KeyGenerator();

  override getDefaultProps(p: MultiValueLineProps<R>): void {
    if (p.ctx.value == undefined)
      p.ctx.value = [];

    p.valueColumClass = "col-sm-12";

    super.getDefaultProps(p);
  }

  // The row type's @valueField (the scalar the row wraps). Required — MultiValueLine is a value line.
  getValueField(): FieldInfo {
    const vf = this.props.ctx.memberType!.typeInfo().valueField;
    if (vf == null)
      throw new Error(`MultiValueLine: row type '${this.props.ctx.memberType!.getTypeName()}' must declare a @valueField`);
    return vf;
  }

  // Wrap a scalar value into a new row: `RowType.create({ [valueField]: value })`.
  createRow(value: unknown): R {
    const ctor = this.props.ctx.memberType!.getFunction();
    if (ctor == null)
      throw new Error(`MultiValueLine: row type '${this.props.ctx.memberType!.getTypeName()}' is not registered`);
    return (ctor as unknown as { create(v: any): R }).create({ [this.getValueField().name]: value });
  }

  handleDeleteValue = (index: number): void => {
    const list = this.props.ctx.value;
    list.removeAt(index);
    this.setValue(list);
  }

  handleAddValue = (e: React.MouseEvent<any>): void => {
    e.preventDefault();
    const list = this.props.ctx.value;
    const newValuePromise = this.props.onCreate == null ? this.defaultCreate() : this.props.onCreate();

    newValuePromise.then(v => {
      if (v === undefined)
        return;

      if (Array.isArray(v))
        list.push(...v.map(e => this.createRow(e)));
      else
        list.push(this.createRow(v));

      this.setValue(list);
    });
  }

  // ALTEA: Signum added a null MList element; here we create a row with a null/default @valueField
  // (the inline AutoLine then edits it).
  defaultCreate(): Promise<null> {
    return Promise.resolve(null);
  }

  getMListItemContext(ctx: TypeContext<R[]>): TypeContext<R>[] {
    var rows = mlistItemContext(ctx);

    if (this.props.filterRows)
      return this.props.filterRows(rows);

    return rows;
  }
}

export const MultiValueLine: <R extends BaseEntity>(props: MultiValueLineProps<R>) => React.ReactNode | null
  = genericMemo(function MultiValueLine<R extends BaseEntity>(props: MultiValueLineProps<R>) {

    const c = useController<MultiValueLineController<R>, MultiValueLineProps<R>, R[]>(MultiValueLineController<R>, props);
    const p = c.props;

    // ALTEA: each element edits its row's @valueField sub-context via AutoLine (Signum rendered the
    // MList element — the scalar — directly). onRenderItem lets callers customise the editor.
    const renderItem = props.onRenderItem ?? ((ap: AutoLineProps) => <AutoLine {...ap} />);

    if (c.isHidden)
      return null;

    const valueFieldName = c.getValueField().name;

    const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
    const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon}
        htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }}
        helpText={helpText}
        helpTextOnTop={helpTextOnTop}
        labelHtmlAttributes={p.labelHtmlAttributes}>
        {inputId => <>
          <div className="row">
            {
              c.getMListItemContext(p.ctx.subCtx({ formGroupStyle: "None" })).map((mlec, i) => {
                return (
                  <ErrorBoundary key={c.keyGenerator.getKey(mlec.value)}>
                    <div className={p.valueColumClass!} >
                      <MultiValueLineElement
                        ctx={mlec.subCtx(valueFieldName)}
                        onRemove={e => { e.preventDefault(); c.handleDeleteValue(i); }}
                        onRenderItem={renderItem}
                        valueColumClass={p.valueColumClass!} />
                    </div>
                  </ErrorBoundary>
                );
              })
            }
          </div>
          {!p.ctx.readOnly &&
            <LinkButton title={p.ctx.titleLabels ? p.addValueText ?? SearchMessage.AddValue.niceToString() : undefined}
              className="sf-line-button sf-create"
              onClick={c.handleAddValue}>
              {EntityBaseController.getCreateIcon()}&nbsp;{p.addValueText ?? SearchMessage.AddValue.niceToString()}
            </LinkButton>}
        </>}
      </FormGroup>
    );
  });

export interface MultiValueLineElementProps {
  ctx: TypeContext<any>;
  onRemove: (event: React.MouseEvent<any>) => void;
  onRenderItem: (p: AutoLineProps) => React.ReactElement;
  valueColumClass: string;
}

export function MultiValueLineElement(props: MultiValueLineElementProps): React.ReactElement {
  const mctx = props.ctx;

  return (
    <div className={classes("sf-multi-value-element")}>
      {!mctx.readOnly &&
        <LinkButton
          title={mctx.titleLabels ? SearchMessage.DeleteFilter.niceToString() : undefined}
          className="sf-line-button sf-remove"
          onClick={props.onRemove}>
          <FontAwesomeIcon aria-hidden={true} icon="xmark" />
        </LinkButton>
      }
      {React.cloneElement(props.onRenderItem({ ctx: mctx, mandatory: true })!)}
    </div>
  );
}
