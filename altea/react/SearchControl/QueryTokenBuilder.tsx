// Ported from Signum.React/SearchControl/QueryTokenBuilder.tsx — copy-paste + fix. altea fixes:
//   - QueryToken is a CLASS: `token.fullKey`→`token.fullKey()`, `token.toStr`→`token.niceName()`,
//     `token.niceTypeName`→`token.niceTypeName()` (all methods); `token.type` is a TypeReference so
//     `.isCollection`→`.array`, `.name`→`.getTypeName()`.
//   - react-widgets `textField`/`dataKey` take ACCESSOR FUNCTIONS (altea has methods, not the flat
//     `toStr`/`fullKey` string props Signum's DTO had).
//   - StyleContext from ../TypeContext (Signum re-exports it from the Lines barrel).
//   - MANUAL sub-tokens are DEFERRED (altea has no `queryTokenType` discriminator / ManualToken yet):
//     the `manualSubTokens` registry + register/clear stay as the public API, but `getManualSubTokens`
//     always returns undefined for now (TODO(port): manual/cell tokens).
import * as React from 'react'
import { classes, Dic } from '../../entities/globals'
import { Finder } from '../Finder'
import type { QueryDescription } from '../FindOptions'
import { SubTokensOptions } from '../QueryToken'
import { QueryToken } from '../QueryToken';
import "./QueryTokenBuilder.css"
import { DropdownList } from 'react-widgets-up'
import { StyleContext } from '../TypeContext';
import { useAPI } from '../Hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

interface QueryTokenBuilderProps {
  prefixQueryToken?: QueryToken | undefined;
  queryToken: QueryToken | undefined | null;
  onTokenChange: (newToken: QueryToken | undefined) => void;
  queryKey: string;
  subTokenOptions: SubTokensOptions;
  readOnly: boolean;
  className?: string;
}

let copiedToken: { fullKey: string, queryKey: string } | undefined;

export default function QueryTokenBuilder(p: QueryTokenBuilderProps): React.ReactElement {

  var [expanded, setExpanded] = React.useState(false);
  const [lastTokenChanged, setLastTokenChanged] = React.useState<string | undefined>(undefined);


  React.useEffect(() => {
    setExpanded(false);
  }, [p.queryKey, p.prefixQueryToken]);

  const qd = useAPI(() => Finder.getQueryDescription(p.queryKey), [p.queryKey]);

  function handleExpandButton(e: React.MouseEvent<any>) {
    setExpanded(true);
  }

  let tokenList: (QueryToken | undefined)[] = [...(p.queryToken?.getTokenParents() ?? [])];

  var initialIndex = !expanded && p.prefixQueryToken && p.queryToken && p.prefixQueryToken.isPrefixOf(p.queryToken) ?
    tokenList.findIndex(a => a!.fullKey() == p.prefixQueryToken!.fullKey()) + 1 : 0;

  if (!p.readOnly)
    tokenList.push(undefined);

  return (
    <div className={classes("sf-query-token-builder", p.className)} onKeyDown={handleKeyDown} data-token={p.queryToken?.fullKey()}>
      {initialIndex != 0 && <button type="button" onClick={handleExpandButton} className="btn btn-sm sf-prefix-btn">…</button>}
      {qd && tokenList.map((a, i) => {
        if (i < initialIndex)
          return null;

        var parentToken = i == 0 ? undefined : tokenList[i - 1]!;

        return (
          <QueryTokenPart key={i == 0 ? "__first__" : parentToken!.fullKey()}
            queryDescription={qd}
            queryKey={p.queryKey}
            readOnly={p.readOnly}
            setLastTokenChange={(fullKey) => { setLastTokenChanged(fullKey); }}
            onTokenSelected={async (qt, keyboard) => {
              var nqt = (await tryApplyToken(p.queryToken, qt)) ?? qt;
              setLastTokenChanged(keyboard ? nqt?.fullKey() : undefined);
              p.onTokenChange && p.onTokenChange(nqt);
            }}
            defaultOpen={lastTokenChanged && i > 0 && lastTokenChanged == parentToken!.fullKey()
          /*&& (tokenList[i - 1]!.type.array)*/ ? true : false}
            subTokenOptions={p.subTokenOptions}
            parentToken={parentToken}
            selectedToken={a} />
        );
      })}
    </div>
  );

  async function tryApplyToken(token: QueryToken | null | undefined, newToken: QueryToken | undefined): Promise<QueryToken | undefined> {
    if (newToken == undefined)
      return undefined;

    if (token == null)
      return newToken;

    if (token.fullKey() == newToken.fullKey())
      return newToken;

    if (token.fullKey().startsWith(newToken.fullKey() + "."))
      return newToken;

    if (newToken.parent == null || token.fullKey().startsWith(newToken.parent.fullKey() + ".")) {
      var tokenParents = token.getTokenParents();
      var newTokenParents = newToken.getTokenParents();

      var extraTokens = tokenParents.slice(newTokenParents.length);

      var tempToken = newToken;
      var tokenCompleter = new Finder.TokenCompleter(qd!);
      for (var i = 0; i < extraTokens.length; i++) {
        var key = extraTokens[i].key;
        var t = (await tokenCompleter.getSubTokens(tempToken, p.subTokenOptions, false)).singleOrNull(a => a.key == key);
        if (t == null)
          return newToken;

        tempToken = t;
      }

      return tempToken;

    } else {
      return newToken;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {

    if (e.ctrlKey) {
      if (e.key == "c") {
        copiedToken = p.queryToken ? {
          fullKey: p.queryToken.fullKey(),
          queryKey: p.queryKey
        } : undefined;
        e.preventDefault();
      }
      else if (e.key == "v" && copiedToken?.queryKey == p.queryKey) {
        Finder.parseSingleToken(p.queryKey, copiedToken.fullKey, p.subTokenOptions)
          .then(a => p.onTokenChange(a));
        e.preventDefault();
      }
    }
  }
}


interface QueryTokenPartProps {
  queryDescription: QueryDescription;
  parentToken: QueryToken | undefined;
  selectedToken: QueryToken | undefined;
  onTokenSelected: (newToken: QueryToken | undefined, keyboard: boolean) => void;
  queryKey: string;
  subTokenOptions: SubTokensOptions;
  readOnly: boolean;
  defaultOpen: boolean;
  setLastTokenChange: (fullKey: string | undefined) => void;
}


export function QueryTokenPart(p: QueryTokenPartProps): React.ReactElement | null {

  const doAutoExpand = !p.parentToken?.type.array;

  const subTokens = useAPI(() => {
    if (p.readOnly)
      return Promise.resolve(undefined);

    const manuals = getManualSubTokens(p.parentToken);
    if (manuals)
      return manuals.then(tokens => tokens.length == 0 ? tokens : [null, ...tokens]);

    var tc = new Finder.TokenCompleter(p.queryDescription);

    return tc.getSubTokens(p.parentToken, p.subTokenOptions, doAutoExpand)
      .then(tokens => tokens.length == 0 ? tokens : [null, ...tokens])
  }, [p.readOnly, p.parentToken && p.parentToken.fullKey(), p.subTokenOptions, p.queryKey])


  const [open, setOpen] = React.useState(p.defaultOpen)


  if (subTokens != undefined && subTokens.length == 0)
    return null;

  return (
    <div className="sf-query-token-part" onKeyUp={handleKeyUp} onKeyDown={handleKeyUp}>
      {p.selectedToken || p.parentToken == null || p.defaultOpen ?
        <DropdownList
          disabled={p.readOnly}
          selectIcon={open && doAutoExpand ? <FontAwesomeIcon aria-hidden={true} icon="magnifying-glass" /> : undefined}
          onToggle={isOpen => setOpen(isOpen)}
          filter={(item, searchTerm) => item != null && searchTerm.toLowerCase().split(" ").filter(a => a != "").every(part => parentsUntil(item, p.parentToken).some(t => t.key.toLowerCase().contains(part) || t.niceName().toLowerCase().contains(part)))}
          autoComplete="off"
          focusFirstItem={true}
          data={subTokens?.orderBy(a => a?.parent != null) ?? []}
          placeholder={p.selectedToken == null ? "..." : undefined}
          value={p.selectedToken}
          onChange={(value, metadata) => p.onTokenSelected(value ?? p.parentToken, metadata.originalEvent?.nativeEvent instanceof KeyboardEvent)}
          dataKey={(item: unknown) => (item as QueryToken | null)?.fullKey()}
          textField={(item: unknown) => (item as QueryToken | null)?.niceName() ?? ""}
          onBlur={() => { p.selectedToken == null && p.setLastTokenChange(undefined); }}
          renderValue={a => <QueryTokenItem item={a.item} />}
          renderListItem={a => <QueryTokenListItem item={a.item} ancestor={p.parentToken} />}
          defaultOpen={p.defaultOpen}
          busy={!p.readOnly && subTokens == undefined}
        /> : <button type="button" className="btn btn-sm sf-query-token-plus" onClick={e => { e.preventDefault(); p.setLastTokenChange(p.parentToken!.fullKey()); }}>
          <FontAwesomeIcon aria-hidden={true} icon="plus" />
        </button>}
    </div>
  );

  function handleKeyUp(e: React.KeyboardEvent<any>) {
    if (e.key == "Enter") {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

export function QueryTokenItem(p: { item: QueryToken | null }): React.ReactElement | null {

  const item = p.item;

  if (item == null)
    return null;



  return (
    <span
      data-full-token={item.fullKey()}
      style={{ color: item.queryTokenColor }}
      title={StyleContext.default.titleLabels ? item.niceTypeName() : undefined}>
      {item.niceName()}
    </span>
  );
}


export function QueryTokenListItem(p: { item: QueryToken | null, ancestor: QueryToken | undefined }): React.ReactElement {

  const item = p.item;

  if (item == null)
    return <span> - </span>;

  return (
    <span data-full-token={item.fullKey()} style={{ whiteSpace: "nowrap" }} className="sf-token-list-item">
      {parentsUntil(item, p.ancestor)
        .map((qt, i) => (
          <React.Fragment key={i}>
            {i > 0 && " › "}
            <span style={{ color: qt.queryTokenColor }} title={StyleContext.default.titleLabels ? qt.niceTypeName() : undefined}>{qt.niceName()}</span>
          </React.Fragment>
        ))}
    </span>
  );
}

function parentsUntil(token: QueryToken, ancestor?: QueryToken) {
  const tokens: QueryToken[] = [];

  for (let t: QueryToken | undefined = token; t != null && t.fullKey() != ancestor?.fullKey(); t = t?.parent) {
    tokens.push(t);
  }

  tokens.reverse();

  return tokens;
}


export function clearManualSubTokens(): void {
  Dic.clear(manualSubTokens);
}

export const manualSubTokens: { [key: string]: (entityType: string) => Promise<QueryToken[]> } = {};

export function registerManualSubTokens(key: string, func: (entityType: string) => Promise<QueryToken[]>): void {
  Dic.addOrThrow(manualSubTokens, key, func);
}

// TODO(port): manual/cell sub-tokens are deferred — altea has no `queryTokenType` discriminator nor a
// ManualToken query-token subclass yet, so no token is ever treated as a manual container. Returns
// undefined so callers fall through to the normal server/local sub-token path.
function getManualSubTokens(_token?: QueryToken): Promise<QueryToken[]> | undefined {
  return undefined;
}
