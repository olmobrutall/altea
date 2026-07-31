import * as React from 'react'
import type { FindOptionsParsed } from '../FindOptions'
import type { QueryToken } from '../QueryToken'

// STUB (SearchControl port). The system-time / temporal-query editor is DEFERRED — the full 303-line
// port needs the SystemTime model UI, SearchValue, the AsOf/Between/TimeSeries date pickers
// (luxon→Temporal) and OperationLog wiring. Renders nothing; SearchControlLoaded only shows it when
// `fo.systemTime` is set. TODO(port).
interface SystemTimeEditorProps {
  findOptions: FindOptionsParsed;
  queryToken: QueryToken;
  onChanged: () => void;
}

export default function SystemTimeEditor(_p: SystemTimeEditorProps): React.ReactElement | null {
  return null;
}
