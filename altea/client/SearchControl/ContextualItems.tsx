// Ported from Signum.React/SearchControl/ContextualItems.tsx — copy-paste + fix. altea fixes:
//   - Lite/Entity from entities; StyleContext from ../TypeContext; dropped unused softCast.
//   - `container?: SearchControlLoaded | React.Component` → `React.Component<any, any>` (SCL isn't
//     ported yet and would be a circular type import; SCL extends React.Component so it stays
//     assignable). TODO(port): tighten to SearchControlLoaded once it lands.
//   - `lite.EntityType` (Signum clean-name string) → `lite.entityType` (altea ctor, accepted by
//     Navigator.getSettings' Type<T> overload).
//   - ErrorModal (not ported) → console.error in the block-error branch.
import * as React from 'react'
import type { QueryToken } from '../QueryToken'
import { Navigator } from '../Navigator'
import type { Lite } from '../../data/lite'
import type { Entity } from '../../data/entity'
import type { StyleContext } from '../TypeContext';
import { Dropdown } from 'react-bootstrap';
import * as AppContext from '../AppContext';

export interface SearchableMenuItem {
  fullText: string; //used for filtering
  menu: React.ReactElement<any>;
}

export type ContextualMenuItem = React.ReactElement<any> | SearchableMenuItem;

export interface MenuItemBlock {
  header: string;
  menuItems: ContextualMenuItem[];
}

export interface ContextMenuPack {
  items: ContextualMenuItem[],
  showSearch: boolean;
}

export interface ContextualItemsContext<T extends Entity> {
  lites: Lite<T>[];
  queryToken: QueryToken;
  markRows: (dictionary: MarkedRowsDictionary) => void;
  container?: React.Component<any, any>;
  styleContext?: StyleContext;
}

export interface MarkedRowsDictionary {
  [liteKey: string]: string | MarkedRow | null;
}

export interface MarkedRow {
  status: "Error" | "Warning" | "Success" | "Muted";
  message?: string;
}

// altea: the contextual-item providers live in `AppContext.clientState`, not a module-level array — see
// the note on Navigator's entitySettings. They are filled by module `start()` calls, so a host that re-runs
// its registration bundle would otherwise show every contextual menu block twice.
type ContextualItemProvider = (ctx: ContextualItemsContext<Entity>) => Promise<MenuItemBlock | undefined> | undefined;
declare module "../AppContext" {
  interface IClientState {
    contextualItems?: ContextualItemProvider[];
  }
}

export function clearContextualItems(): void {
  AppContext.clientState.contextualItems = undefined;
}

export function onContextualItems(): ContextualItemProvider[] {
  return AppContext.clientState.contextualItems ??= [];
}

export function renderContextualItems(ctx: ContextualItemsContext<Entity>): Promise<ContextMenuPack> {

  const blockPromises = onContextualItems().map(func => func(ctx)?.catch(a => ({ error: a, func })));

  return Promise.all(blockPromises).then(blocks => {

    const items: ContextualMenuItem[] = []
    blocks.forEach(block => {

      if (block == undefined)
        return;

      if ("error" in block) {
        items.push(
          <Dropdown className="text-danger" onClick={() => console.error(block.error)}>
            Error in {block.func.name}
          </Dropdown >
        );
        return;
      }

      if (block.menuItems == undefined || block.menuItems.length == 0)
        return;

      if (items.length)
        items.push(<Dropdown.Divider />);

      if (block.header)
        items.push(<Dropdown.Header>{block.header}</Dropdown.Header>);

      // NOT guarded by `block.header` (an earlier port typo): a block without a header still contributes
      // its items, as it does in Signum.
      items.splice(items.length, 0, ...block.menuItems);
    });

    const showSearchFunc = ctx.lites[0] && Navigator.getSettings(ctx.lites[0].entityType)?.showContextualSearchBox;
    const blockWithError = blocks.filter(a => a != null && !("error" in a)) as MenuItemBlock[];
    const showSearch = Boolean(showSearchFunc && showSearchFunc(ctx, blockWithError));

    return ({ items, showSearch });
  });
}
