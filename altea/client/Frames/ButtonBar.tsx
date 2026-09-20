// Ported from Signum.React/Frames/ButtonBar.tsx — copy-and-fix. altea fixes: import paths
// (Globals→entities/globals); dropped the junk `namespace from 'd3'`; `p.pack.entity.Type`→
// `getTypeName(p.pack.entity)` (no `.Type` in altea); type-only imports for verbatimModuleSyntax.
import * as React from 'react'
import { classes, Dic } from '../../data/globals'
import { SearchMessage } from '../../data/uiMessages'
import { AutoFocus } from '../Components/AutoFocus'
import { Navigator } from '../Navigator'
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from '../TypeContext'
import { getTypeName } from '../Reflection'
import { FunctionalAdapter } from '../Modals';
import * as AppContext from '../AppContext';

export interface ButtonBarProps extends ButtonsContext {
  ref?: React.Ref<ButtonBarHandle>;
  align?: "left" | "right";
}

export interface ButtonBarHandle {
  handleKeyDown(e: KeyboardEvent): void;
}


export function ButtonBar(p: ButtonBarProps): React.JSX.Element {

  // The `operations` narrowing, kept only for the operations this entity actually offers. A key that
  // matches nothing means the caller asked for something that is not here, and showing an empty bar would
  // be worse than showing the whole one.
  const qualifiedOperations = React.useMemo(() => {
    if (!p.operations)
      return undefined;

    const currents = Dic.getKeys(p.pack.canExecute);
    const qos = p.operations.split("~").filter(o => currents.some(c => c.toLowerCase().endsWith(`.${o.toLowerCase()}`)));
    return qos.length == 0 ? undefined : qos.join("~");
  }, [p.operations]);

  // Seeded from the url, so a link can land on a bar that is already narrowed. Once `operations` picked
  // the buttons there is nothing left to search, so the box is not offered and the filter starts empty.
  const [currentFilter, setCurrentFilter] = React.useState<string | undefined>(() =>
    qualifiedOperations ? undefined : (p.operations ?? p.filter));

  const [text, setText] = React.useState<string | undefined>(currentFilter);

  const ctx: ButtonsContext = { ...p, operations: qualifiedOperations, filter: currentFilter };
  const rb = FunctionalAdapter.innerRef(ctx.frame.entityComponent) as IRenderButtons | null;

  const es = Navigator.getSettings(getTypeName(p.pack.entity));

  const buttons = ButtonBarManager.onButtonBarRender().flatMap(func => func(ctx) ?? [])
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

  return (
    <div className={classes("btn-toolbar", "sf-button-bar", p.align == "right" ? "justify-content-end" : undefined)}>
      {!qualifiedOperations && ButtonBarManager.showSearch(getTypeName(p.pack.entity), Dic.getKeys(p.pack.canExecute)) && renderSearch()}
      {buttons.map(a => a!.button)}
    </div>
  );

  function renderSearch() {
    return (
      <div className="btn-toolbar-search mb-2 w-100">
        <AutoFocus>
          <label className="label-xs d-inline-flex align-items-center gap-2">
            <span>{SearchMessage.Search.niceToString()}</span>
            <input type="text" className="form-control form-control-xs" value={text} onChange={e => {
              setText(e.currentTarget.value);

              // Below the threshold the filter is DROPPED rather than narrowed to nothing: a half-typed
              // word should leave the bar as it was, not empty it.
              if (e.currentTarget.value.length >= ButtonBarManager.minCharsToSearch(getTypeName(p.pack.entity), Dic.getKeys(p.pack.canExecute)))
                setCurrentFilter(e.currentTarget.value);
              else
                setCurrentFilter(undefined);
            }} />
          </label>
        </AutoFocus>
      </div>
    );
  }
}

// altea: the entity button-bar renderers live in `AppContext.clientState`, not a module-level array — see
// the note on Navigator's entitySettings. They are filled by module `start()` calls, so a host that re-runs
// its registration bundle would otherwise render every operation button twice.
declare module "../AppContext" {
  interface IClientState {
    buttonBarRender?: ((c: ButtonsContext) => Array<ButtonBarElement | undefined> | undefined)[];
  }
}

export namespace ButtonBarManager {

  export function onButtonBarRender(): ((c: ButtonsContext) => Array<ButtonBarElement | undefined> | undefined)[] {
    return AppContext.clientState.buttonBarRender ??= [];
  }

  export function clearButtonBarRenderer(): void{
    AppContext.clientState.buttonBarRender = undefined;
  }

  /** Whether the button bar offers a search box for its operations. Off unless the application replaces
   *  this — a bar with a handful of buttons is not worth searching. */
  export let showSearch: (type: string, operations: string[]) => boolean = () => false;

  /** How much has to be typed before the search applies. */
  export let minCharsToSearch: (type: string, operations: string[]) => number = () => 3;
}
