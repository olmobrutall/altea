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

// Signum's Search.tsx `similarToken`: two token full-keys are "similar" if they match after stripping a
// leading "Entity." prefix (so "Entity.Name" ≡ "Name"). Used by SearchControlLoaded column dedup.
export function similarToken(tokenA: string | undefined, tokenB: string | undefined): boolean {
    return (tokenA?.startsWith("Entity.") ? tokenA.after("Entity.") : tokenA) ==
        (tokenB?.startsWith("Entity.") ? tokenB.after("Entity.") : tokenB);
}
