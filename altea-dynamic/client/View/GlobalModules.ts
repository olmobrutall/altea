import * as React from "react";
import { Temporal } from "@altea/altea/data/basics";
import * as Entities from "@altea/altea/data/entity";
import { Operations } from "@altea/altea/client/Operations";
import { Constructor } from "@altea/altea/client/Constructor";
import * as Globals from "@altea/altea/data/globals";
import { Finder } from "@altea/altea/client/Finder";
import * as Reflection from "@altea/altea/data/reflection";
import { Navigator } from "@altea/altea/client/Navigator";
import * as Components from "@altea/altea/client/Components";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import * as Services from "@altea/altea/client/Services";
import * as AutoCompleteConfig from "@altea/altea/client/Lines/AutoCompleteConfig";
import * as Hooks from "@altea/altea/client/Hooks";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

// Port of Signum.Dynamic's View/GlobalModules.ts — the object bound as `modules` inside every interpreted
// snippet (a node expression, a view's `locals`, a selector, an override). It is the API surface a view
// author writes against, so keeping the KEYS identical to Signum's is what makes a Signum dynamic view
// paste into altea and still resolve.
//
// altea divergences:
//  - `luxon` becomes `Temporal` (the date/time substrate — see CLAUDE.md). The key is renamed rather
//    than aliased: `modules.luxon.DateTime` would resolve to something with a different API, and a silent
//    wrong answer is worse than a missing key.
//  - `TreeClient` is NOT offered, so a Signum view that reaches for it does not resolve. @altea/altea-tree
//    IS ported; adding the key would make this package depend on it, which is the open question — see
//    docs/port/Dynamic.md.
//  - `Navigator` / `Finder` / `Operations` / `AuthClient` are NAMESPACE objects here (Signum exports
//    some of these as modules and some as namespaces); the shape a snippet sees is the same either way.
export const globalModules: Record<string, unknown> = {
    Temporal,
    React,
    Components,
    Globals,
    Navigator,
    Finder,
    Reflection,
    Entities,
    AuthClient,
    Operations,
    Constructor,
    Services,
    AutoCompleteConfig,
    Hooks,
    SelectorModal,
    FontAwesomeIcon,
};
