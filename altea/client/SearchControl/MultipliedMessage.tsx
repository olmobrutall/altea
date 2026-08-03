// Ported from Signum.React/SearchControl/MultipliedMessage.tsx — copy-paste + fix. altea fixes:
//   - TypeReference from entities/reflection; `getTypeInfos(p.mainType)` (removed in the de-string-ify
//     pass) → `p.mainType.typeInfos()`; FilterOptionParsed from ../FindOptions.
//   - QueryToken is a class: `.queryTokenType == "ToArray"|"Element"` → `isToArray`/`isElement`;
//     `.fullKey`→`fullKey()`, `.niceName`→`niceName()`, `.nicePluralName`→`getNicePluralName()`.
import * as React from 'react'
import type { FindOptionsParsed, FilterOptionParsed } from '../FindOptions'
import { isFilterGroup } from '../FindOptions'
import { QueryToken } from '../QueryToken';
import type { TypeReference } from '../../data/reflection'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { CollectionMessage } from '../../data/dynamicQueries';
import { ValidationMessage } from '../../data/validators';
import '../AppContext'

export default function MultipliedMessage(p: { findOptions: FindOptionsParsed, mainType: TypeReference }): React.ReactElement | null {

  const tokens = multiplyResultTokens(p.findOptions);

  if (tokens.length == 0)
    return null;

  const message = ValidationMessage.TheNumberOf0IsBeingMultipliedBy1.niceToString().formatHtml(
    p.mainType.typeInfos().map(a => a.getNicePluralName()).joinComma(CollectionMessage.And.niceToString()),
    tokens.map(a => <strong>{a.parent!.niceName()}</strong>).joinCommaHtml(CollectionMessage.And.niceToString()))

  return (
    <div className="sf-search-message alert alert-warning">
      <FontAwesomeIcon aria-hidden={true} icon="triangle-exclamation" />&nbsp;{message}
    </div>
  );
}

export function multiplyResultTokens(fops: FindOptionsParsed): QueryToken[] {
  function getFilterTokens(fop: FilterOptionParsed): (QueryToken | undefined)[] {
    if (isFilterGroup(fop))
      return fop.filters.flatMap(f => getFilterTokens(f));
    else
      return [fop.operation == undefined ? undefined : fop.token]
  }


  function getFilterRemoveElemetWarnings(fop: FilterOptionParsed): (QueryToken | undefined)[] {
    if (isFilterGroup(fop))
      return fop.filters.flatMap(f => getFilterTokens(f));
    else
      return [fop.operation == undefined || !fop.removeElementWarning ? undefined : fop.token]
  }

  function getElementsTokens(tokens: (QueryToken | null | undefined)[]): QueryToken[] {
    return tokens.filter(a => a != undefined)
      .flatMap(a => {
        var parts = a.getTokenParents();

        var toArrayIndex = parts.findIndex(a => a.isToArray());
        if (toArrayIndex == -1)
          return parts;

        return parts.slice(0, toArrayIndex);
      })
      .filter(a => a.isElement())
      .distinctBy(a => a.fullKey());
  }

  const removeTokens = getElementsTokens(fops.filterOptions.flatMap(fo => getFilterRemoveElemetWarnings(fo)));

  const candidateTokens = fops.columnOptions.map(a => a.token)
    .concat(fops.filterOptions.flatMap(fo => getFilterTokens(fo)))
    .concat(fops.orderOptions.map(a => a.token));

  return getElementsTokens(candidateTokens).filter(t => !removeTokens.some(r => r.fullKey() == t.fullKey()));
}
