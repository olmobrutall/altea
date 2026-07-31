import type { FindOptionsParsed } from '../FindOptions'
import type { QueryToken } from '../QueryToken'

// STUB (SearchControl port). The bulk "edit all columns" modal is DEFERRED — the full 287-line port
// needs DraggableTable + Finder.parseColumnOptions/getDefaultColumns + the group/order editor grid.
// SearchControlLoaded calls `ColumnEditorModal.show(...)`; the stub resolves `false` (no changes made),
// so the toolbar button is a no-op until ported. TODO(port).
const ColumnEditorModal = {
  show(_findOptions: FindOptionsParsed, _queryToken: QueryToken, _querySettings?: any): Promise<boolean> {
    return Promise.resolve(false);
  }
};

export default ColumnEditorModal;
