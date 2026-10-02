// Ported from Signum.React/Lines/FormControlReadonly.tsx — copy-paste + fix (imports retargeted).
import * as React from 'react'
import { type StyleContext } from '../TypeContext';
import { classes } from '../../data/globals';
import "./Lines.css"

export interface FormControlReadonlyProps {
  ctx: StyleContext;
  htmlAttributes?: React.HTMLAttributes<any>;
  className?: string;
  innerRef?: React.Ref<HTMLElement>;
  children?: React.ReactNode;
  id: string;
}

export function FormControlReadonly({ ctx, htmlAttributes: attrs, className, innerRef, children, id }: FormControlReadonlyProps): React.ReactElement {

  const array = React.Children.toArray(children);
  // An EMPTY field renders the input too, with no value. As a div it was role="group", on which aria-invalid
  // is not supported and whose description is not read, so a required read-only field that was empty never
  // said it was invalid or why. An input is read as "edit, read only, invalid entry" with its message, and
  // both look the same (Lines.css styles .readonly and [readonly] alike).
  const onlyText = array.length == 1 && typeof array[0] == "string" ? array[0] as string : array.length == 0 ? "" : undefined;

  // FormGroup's <label for> points at this id, but a div is not labelable, so the label reached nobody.
  // Found after rendering, because the label is the FormGroup's.
  const explicitName = attrs?.["aria-label"] || attrs?.["aria-labelledby"];
  const [labelId, setLabelId] = React.useState<string | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (onlyText != undefined || explicitName) {
      setLabelId(undefined);
      return;
    }
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label && !label.id)
      label.id = id + "_label";
    setLabelId(label?.id);
  }, [id, onlyText, explicitName]);

  if (onlyText != undefined) { //Text is scrollable in inputs
    if (ctx.readonlyAsPlainText) {
      return (
        <input id={id} {...attrs} readOnly className={classes(ctx.formControlPlainTextClass, attrs?.className, className)} tabIndex={0} value={onlyText} ref={innerRef as React.RefObject<HTMLInputElement>} />
      );
    } else {
      return (
        <input id={id} {...attrs} readOnly className={classes(ctx.formControlClass, attrs?.className, className)} tabIndex={0} value={onlyText} ref={innerRef as React.RefObject<HTMLInputElement>} />
      );
    }
  }
  else {
    // On a div without a role, aria-label is prohibited and aria-readonly is not allowed at all, so the name
    // was dropped. aria-readonly only means something on a widget and goes; a named div becomes a group,
    // which may carry the name. Named by the LABEL only — the group's own content is announced after the
    // name, so naming it with the value as well read every such field twice.
    const { "aria-readonly": _readonly, ...labelledAttrs } = attrs ?? {};
    const divAttrs = labelId ? { ...labelledAttrs, "aria-labelledby": labelId } : labelledAttrs;
    const role = divAttrs.role ?? (divAttrs["aria-label"] || divAttrs["aria-labelledby"] ? "group" : undefined);

    if (ctx.readonlyAsPlainText) {
      return (
        <div id={id}  {...divAttrs} role={role} className={classes(ctx.formControlPlainTextClass, "readonly", attrs?.className, className)} tabIndex={0} ref={innerRef as React.RefObject<HTMLDivElement>}>
          {children ?? <span>&nbsp;</span>}
        </div>
      );
    } else {
      return (
        <div id={id} {...divAttrs} role={role} className={classes(ctx.formControlClass, "readonly", attrs?.className, className)} tabIndex={0} ref={innerRef as React.RefObject<HTMLDivElement>}>
          {children ?? <span>&nbsp;</span>}
        </div>
      );
    }
  }
}
