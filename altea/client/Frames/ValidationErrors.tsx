// Ported from Signum.React/Frames/ValidationErrors.tsx — copy-and-fix. altea fixes: import paths
// (Globals→entities/globals); ModifiableEntity→BaseEntity; altea ModelState values are single strings
// (not string[]), so `value.join("\n")` → `value`.
import * as React from 'react'
import { Dic } from '../../entities/globals'
import type { BaseEntity } from '../../entities/entity'
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

  return (
    <ul className="validaton-summary alert alert-danger">
      {Dic.map(modelState, (key, value) => <li
        key={key}
        style={{ cursor: "pointer", whiteSpace: "pre-wrap" }}
        onClick={() => handleOnClick(key)}
        title={key.after(p.prefix + ".")}>
        {value}
      </li>)}
    </ul>
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
