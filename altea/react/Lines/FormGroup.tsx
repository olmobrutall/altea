// Ported from Signum.React/Lines/FormGroup.tsx — copy-paste + fix (imports retargeted; member is a
// name string in altea, its metadata is on fieldInfo).
import * as React from 'react'
import { type StyleContext, type TypeContext } from '../TypeContext';
import { classes } from '../../entities/globals';
import "./Lines.css"

export interface FormGroupProps {
  label?: React.ReactNode;
  labelIcon?: React.ReactNode;
  ctx: StyleContext;
  labelHtmlAttributes?: React.HTMLAttributes<HTMLLabelElement>;
  htmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
  ariaAttributes?: React.AriaAttributes;
  helpText?: React.ReactNode;
  helpTextOnTop?: React.ReactNode;
  error?: string | null | undefined;
  children?: (inputId: string) => React.ReactNode;
}

export function FormGroup(p: FormGroupProps): React.ReactElement {
  const ctx = p.ctx;
  const controlId = React.useId();

  const tCtx = ctx as TypeContext<any>;
  const error = p.error === undefined ? tCtx.error : p.error;
  const errorClass = error && "has-error";
  const errorAtts = error && {
    title: error,
    "data-error-path": tCtx.prefix
  };

  if (ctx.formGroupStyle == "None") {
    const c = p.children?.(controlId);

    return (
      <span {...p.htmlAttributes} className={classes(errorClass, p.htmlAttributes?.className)} {...errorAtts}>
        {c}
      </span>
    );
  }

  const requiredIndicator = (tCtx.propertyRoute?.fieldInfo && !tCtx.propertyRoute.fieldInfo.isNullable) && !p.ariaAttributes?.['aria-readonly'];

  const labelClasses = classes(
    ctx.formGroupStyle == "SrOnly" && "visually-hidden",
    ctx.formGroupStyle == "LabelColumns" && ctx.labelColumnsCss,
    ctx.formGroupStyle == "LabelColumns" ? ctx.colFormLabelClass : ctx.labelClass,
  );

  let pr = tCtx.propertyRoute;
  var labelText = p.label ?? (pr?.fieldInfo?.niceToString());
  const label = (
    <label htmlFor={controlId} {...p.labelHtmlAttributes} className={classes(p.labelHtmlAttributes?.className, labelClasses)} >
      {labelText}{requiredIndicator && <span aria-hidden="true" className="required-indicator">*</span>} {p.labelIcon}
    </label>
  );

  const formGroupClasses = classes(ctx.formGroupClass,
    ctx.formGroupStyle == "LabelColumns" ? "row" : undefined,
    ctx.formGroupStyle == "FloatingLabel" ? "form-floating" : undefined,
    errorClass);
  return (
    <div
      title={ctx.titleLabels && typeof labelText == "string" ? labelText : undefined}
      {...p.htmlAttributes}
      className={classes(p.htmlAttributes?.className, formGroupClasses)}
      {...errorAtts}>
      {(ctx.formGroupStyle == "Basic" || ctx.formGroupStyle == "LabelColumns" || ctx.formGroupStyle == "SrOnly") && label}
      {p.helpTextOnTop && ctx.formGroupStyle != "LabelColumns" && <small className="form-text d-block">{p.helpTextOnTop}</small>}
      {
        ctx.formGroupStyle != "LabelColumns" ? p.children?.(controlId) :
          (
            <div className={ctx.valueColumnsCss} >
              {p.helpTextOnTop && ctx.formGroupStyle == "LabelColumns" && <small className="form-text d-block">{p.helpTextOnTop}</small>}
              {p.children?.(controlId)}
              {p.helpText && ctx.formGroupStyle == "LabelColumns" && <small className="form-text d-block">{p.helpText}</small>}
            </div>
          )
      }
      {(ctx.formGroupStyle == "BasicDown" || ctx.formGroupStyle == "FloatingLabel") && label}
      {p.helpText && ctx.formGroupStyle != "LabelColumns" && <small className="form-text d-block">{p.helpText}</small>}
    </div>
  );

}
