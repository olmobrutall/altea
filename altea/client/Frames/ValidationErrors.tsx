// Ported from Signum.React/Frames/ValidationErrors.tsx — copy-and-fix. altea fixes: import paths
// (Globals→entities/globals); ModifiableEntity→BaseEntity; altea ModelState values are single strings
// (not string[]), so `value.join("\n")` → `value`.
import * as React from 'react'
import { Dic } from '../../data/globals'
import type { BaseEntity } from '../../data/entity'
import { GraphExplorer } from '../Reflection'
import { useForceUpdate } from '../Hooks';


export interface ValidationErrorsHandle {
  forceUpdate(): void;
}

export function ValidationErrors(p: { entity: BaseEntity, prefix: string, ref?: React.Ref<ValidationErrorsHandle> }): React.JSX.Element | null {

  const forceUpdate = useForceUpdate();

  React.useImperativeHandle(p.ref, () => ({ forceUpdate }), []);

  const modelState = GraphExplorer.collectModelState(p.entity, p.prefix);

  if (!modelState || Dic.getKeys(modelState).length == 0)
    return null;

  // role="alert" so the summary is announced when it appears after a failed save. Until now it was
  // inserted silently, which is why a screen reader reported a field as invalid but never said why.
  // "alert" rather than "status": this interrupts, which is right for an error blocking the save.
  // The role goes on a WRAPPER, not on the <ul>: a role replaces the element's own, so role="alert" on the
  // list made it stop being a list and left every <li> an orphan. A plain div announces just the same and
  // the list stays a list.
  return (
    <div role="alert">
    <ul className="validaton-summary alert alert-danger">
      {Dic.map(modelState, (key, value) => <li
        key={key}
        style={{ cursor: "pointer", whiteSpace: "pre-wrap" }}
        onClick={() => handleOnClick(key)}
        title={key.after(p.prefix + ".")}>
        {value}
      </li>)}
    </ul>
    </div>
  );

  function handleOnClick(key: string) {

    var result = document.querySelector(`[data-error-path='${key}']`);
    if (result != null && result.checkVisibility()) {
      result.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
      var input = result.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (input)
        (input as HTMLInputElement).focus();
    } else {
      var subKey = key.tryBeforeLast(".");
      while (subKey) {
        var container = document.querySelector(`[data-error-container='${subKey}']`);
        if (container) {
          (container as HTMLElement).dispatchEvent(new Event("openError"));
          setTimeout(() => handleOnClick(key), 200);

          return;
        }

        subKey = subKey.tryBeforeLast(".");
      }
    }
  }
}
