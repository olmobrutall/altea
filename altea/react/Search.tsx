// STUB (Phase 4). The real SearchControl / SearchControlLoaded are not ported yet; FindOptions
// references these shapes for modal-search options. Replace with the full port in Phase 4.
import type { FindOptions } from "./FindOptions";

export interface SearchControlProps {
    findOptions: FindOptions;
    // TODO(phase4): the full SearchControl prop surface.
}

export interface SearchControlLoaded {
    // TODO(phase4): the loaded SearchControl instance surface (used by ModalFindOptions.onOKClicked).
}
