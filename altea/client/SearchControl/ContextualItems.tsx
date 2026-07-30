// Ported from Signum.React/SearchControl/ContextualItems.tsx — copy-paste + fix. altea fixes:
//   - Lite/Entity from entities; StyleContext from ../TypeContext; dropped unused softCast.
//   - `container?: SearchControlLoaded | React.Component` → `React.Component<any, any>` (SCL isn't
//     ported yet and would be a circular type import; SCL extends React.Component so it stays
//     assignable). TODO(port): tighten to SearchControlLoaded once it lands.
//   - `lite.EntityType` (Signum clean-name string) → `lite.entityType` (altea ctor, accepted by
//     Navigator.getSettings' Type<T> overload).
//   - ErrorModal (not ported) → console.error in the block-error branch.
import * as React from 'react'
import type { QueryDescription } from '../FindOptions'
import { Navigator } from '../Navigator'
import type { Lite } from '../../entities/lite'
import type { Entity } from '../../entities/entity'
import type { StyleContext } from '../TypeContext';
import { Dropdown } from 'react-bootstrap';

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
  queryDescription: QueryDescription;
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

export function clearContextualItems(): void {
  onContextualItems.clear();
}

export const onContextualItems: ((ctx: ContextualItemsContext<Entity>) => Promise<MenuItemBlock | undefined> | undefined)[] = [];

export function renderContextualItems(ctx: ContextualItemsContext<Entity>): Promise<ContextMenuPack> {

  const blockPromises = onContextualItems.map(func => func(ctx)?.catch(a => ({ error: a, func })));

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

      if (block.header)
        items.splice(items.length, 0, ...block.menuItems);
    });

    const showSearchFunc = ctx.lites[0] && Navigator.getSettings(ctx.lites[0].entityType)?.showContextualSearchBox;
    const blockWithError = blocks.filter(a => a != null && !("error" in a)) as MenuItemBlock[];
    const showSearch = Boolean(showSearchFunc && showSearchFunc(ctx, blockWithError));

    return ({ items, showSearch });
  });
}
