// Ported from Signum.React/SearchControl/GroupByMessage.tsx — copy-paste + fix. altea fixes:
//   - TypeReference from entities/reflection; getQueryNiceName from ../Reflection; CollectionMessage
//     from entities/dynamicQueries; ValidationMessage from entities/validators.
//   - QueryToken is a class: `.queryTokenType != "Aggregate"` → `!a.isAggregate()`; `.fullKey`→`fullKey()`,
//     `.niceName`→`niceName()`. formatHtml/joinCommaHtml installed via ../AppContext.
import * as React from 'react'
import { Dic } from '../../entities/globals'
import type { FindOptionsParsed } from '../FindOptions'
import type { TypeReference } from '../../entities/reflection'
import { getQueryNiceName } from '../Reflection'
import { } from '../QueryToken'
import { ValidationMessage } from '../../entities/validators';
import { CollectionMessage } from '../../entities/dynamicQueries';
import { VisualTipIcon, SearchVisualTip } from '../Basics/VisualTipIcon';
import { GroupHelp } from './SearchControlVisualTips';
import '../AppContext'

export default function GroupByMessage(p: { findOptions: FindOptionsParsed, mainType: TypeReference }): React.ReactElement {
  const fo = p.findOptions;

  const tokensObj = fo.columnOptions.map(a => a.token)
    .concat(fo.orderOptions.map(a => a.token))
    .filter(a => a != undefined && !a.isAggregate())
    .toObjectDistinct(a => a!.fullKey(), a => a!);

  const tokens = Dic.getValues(tokensObj);

  const message = ValidationMessage.EachRowRepresentsAGroupOf0WithSame1.niceToString().formatHtml(getQueryNiceName(fo.queryKey),
    tokens.map(a => <strong>{a.niceName()}</strong>).joinCommaHtml(CollectionMessage.And.niceToString()));
  return (
    <div className="sf-search-message alert alert-info">
      {"Ʃ"}&nbsp;{message}
      <VisualTipIcon visualTip={SearchVisualTip.GroupHelp} content={props => <GroupHelp injected={props} />} />
    </div>
  );
}
