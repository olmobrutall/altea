import { reflect } from "./reflection";
import { entity } from "./decorators";
import { Symbol } from "./symbol";

// Port of Signum's `TourTriggerSymbol` (Signum/Basics/TourTriggerLogic.cs) — a named place to anchor an
// application tour.
//
// It lives in the FRAMEWORK, not in the optional @altea/altea-tour module, exactly as Signum places it:
// any module can declare its own triggers and hang a `<TourButton trigger={…} />` beside a page without
// taking a dependency on the tour module. If the application never starts altea-tour the declarations
// are simply inert (nothing registers them into the symbol table, and TourButton renders nothing).
//
// Declare one the way any altea symbol is declared:
//
//     export namespace MyTourTrigger { export const OrderDashboard: TourTriggerSymbol = init(); }
//     TourTriggerLogic.registerTourTriggers(MyTourTrigger.OrderDashboard);
@reflect
@entity("String", "Master", { lowPopulation: true })
export class TourTriggerSymbol extends Symbol { }
