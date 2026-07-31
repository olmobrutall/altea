import * as React from 'react';
import type { QueryToken } from '../QueryToken';

// STUB (SearchControl port). The filter/column/search help-overlay content is DEFERRED along with the
// VisualTipIcon subsystem (see react/Basics/VisualTipIcon). Renders nothing; wired through so the
// FilterBuilder / ColumnEditor call sites stay faithful. TODO(port): the full 185-line visual tips.
export function FilterHelp(_p: { queryToken: QueryToken; injected: unknown }): React.ReactElement | null {
  return null;
}

export function ColumnHelp(_p: { queryToken: QueryToken; injected: unknown }): React.ReactElement | null {
  return null;
}

export function GroupHelp(_p: { injected: unknown }): React.ReactElement | null {
  return null;
}

export function SearchHelp(_p: { sc?: unknown; injected: unknown }): React.ReactElement | null {
  return null;
}
