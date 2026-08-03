// Ported from Signum.React/Frames/ButtonBar.tsx — copy-and-fix. altea fixes: import paths
// (Globals→entities/globals); dropped the junk `namespace from 'd3'`; `p.pack.entity.Type`→
// `getTypeName(p.pack.entity)` (no `.Type` in altea); type-only imports for verbatimModuleSyntax.
import * as React from 'react'
import { classes } from '../../data/globals'
import { Navigator } from '../Navigator'
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from '../TypeContext'
import { getTypeName } from '../Reflection'
import { FunctionalAdapter } from '../Modals';

export interface ButtonBarProps extends ButtonsContext {
  ref?: React.Ref<ButtonBarHandle>;
  align?: "left" | "right";
}

export interface ButtonBarHandle {
  handleKeyDown(e: KeyboardEvent): void;
}


export function ButtonBar(p: ButtonBarProps): React.JSX.Element {

  const ctx: ButtonsContext = p;
  const rb = FunctionalAdapter.innerRef(ctx.frame.entityComponent) as IRenderButtons | null;

  const es = Navigator.getSettings(getTypeName(p.pack.entity));

  const buttons = ButtonBarManager.onButtonBarRender.flatMap(func => func(p) ?? [])
    .concat(rb?.renderButtons ? rb.renderButtons(ctx) : [])
    .concat(es?.extraToolbarButtons ? es.extraToolbarButtons(ctx) : [])
    .filter(a => a != null)
    .orderBy(a => a!.order ?? 0);

  var shortcuts = buttons.filter(a => a!.shortcut != null).map(a => a!.shortcut!);

    function handleKeyDown(e: KeyboardEvent) {
    var s = shortcuts;
    if (s != null) {
      for (var i = 0; i < s.length; i++) {
        if (s[i](e)) {
          e.preventDefault();
          return;
        }
      }
    }
  }
  React.useImperativeHandle(p.ref, () => ({
    handleKeyDown
  }));

  return React.cloneElement(<div className={classes("btn-toolbar", "sf-button-bar", p.align == "right" ? "justify-content-end" : undefined)} />,
    undefined,
    ...buttons.map(a => a!.button)
  );
}

export namespace ButtonBarManager {

  export const onButtonBarRender = [] as ((c: ButtonsContext) => Array<ButtonBarElement | undefined> | undefined)[];

  export function clearButtonBarRenderer(): void{
    onButtonBarRender.clear();
  }
}
