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
  const onlyText = array.length == 1 && typeof array[0] == "string" ? array[0] as string : undefined;

  if (onlyText) { //Text is scrollable in inputs
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
    if (ctx.readonlyAsPlainText) {
      return (
        <div id={id}  {...attrs} className={classes(ctx.formControlPlainTextClass, "readonly", attrs?.className, className)} tabIndex={0} ref={innerRef as React.RefObject<HTMLDivElement>}>
          {children ?? <span>&nbsp;</span>}
        </div>
      );
    } else {
      return (
        <div id={id} {...attrs} className={classes(ctx.formControlClass, "readonly", attrs?.className, className)} tabIndex={0} ref={innerRef as React.RefObject<HTMLDivElement>}>
          {children ?? <span>&nbsp;</span>}
        </div>
      );
    }
  }
}
