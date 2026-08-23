import * as React from "react";
import type * as d3 from "d3";
import * as AppContext from "@altea/altea/client/AppContext";
import type { SchemaMapInfo, TableInfo, RelationInfo } from "../../data/Map";

// Port of Signum.Map's Schema/ClientColorProvider.ts — the CLIENT half of a colour provider (the scale
// that turns a table into a fill / stroke / tooltip), plus the d3-facing SUPERTYPES the layout mutates.
//
// The wire shapes themselves (TableInfo / RelationInfo / SchemaMapInfo) are declared once in the DATA
// layer; what lives here is only what d3 adds to them in the browser: the simulation's position and
// velocity fields, the measured box, and the resolved source/target of a link.
//
// altea divergences:
//  - **The registry lives in `clientState`, not in a module global reset through
//    `clearSettingsActions`.** Signum pushes `MapClient.clearProviders` onto that global list; altea has
//    no such list — every client module keeps its mutable state on `AppContext.clientState` and
//    `newClientState()` resets all of them at once on a credential change (see AppContext's header). One
//    consequence is visible in MapClient: there is no `clearProviders` to export.
//  - `MListTableInfo` / `MListRelationInfo` / `ITableInfo.sql` are gone — the first two with MList (see
//    data/Map.ts), the third because Signum never set or read it.

// ---- the layout fields d3 owns -------------------------------------------------------------------

export interface Point {
    x?: number; // Really not nullable, but that is how d3's typings model a not-yet-placed node
    y?: number;
}

export interface Rectangle extends Point {
    width: number;
    height: number;
}

/** A schema-map NODE: the server's TableInfo plus everything the simulation writes onto it. */
export interface ITableInfo extends TableInfo, d3.SimulationNodeDatum, Rectangle {
    width: number;
    height: number;
}

/** A schema-map EDGE: the server's RelationInfo plus the resolved endpoints and the drawn curve. */
export interface IRelationInfo extends RelationInfo, d3.SimulationLinkDatum<ITableInfo> {
    /** How many other edges already join the same PAIR — bows each one out by a different amount. */
    repetitions: number;
    sourcePoint: Point;
    targetPoint: Point;
}

/** The map as the page holds it: the server payload plus the resolved node / link arrays. */
export interface SchemaMapD3Info extends SchemaMapInfo {
    allNodes: ITableInfo[];
    allLinks: IRelationInfo[];
}

// ---- the provider contract -----------------------------------------------------------------------

export interface ClientColorProvider {
    /** Must match a `MapColorProviderInfo.name` from the server, exactly. */
    name: string;
    getFill: (t: ITableInfo) => string;
    getStroke?: (t: ITableInfo) => string;
    getTooltip: (t: ITableInfo) => string;
    getMask?: (t: ITableInfo) => string | undefined;
    /** Extra `<defs>` the fills reference — the auth provider's gradients. */
    defs?: React.JSX.Element[];
}

// ---- the registry ---------------------------------------------------------------------------------

declare module "@altea/altea/client/AppContext" {
    interface IClientState {
        map?: MapClientState;
    }
}

interface MapClientState {
    colorProviderFactories: ((info: SchemaMapInfo) => Promise<ClientColorProvider[]>)[];
}

function state(): MapClientState {
    return AppContext.clientState.map ??= { colorProviderFactories: [] };
}

/** Signum's `getColorProviders` array. Each factory may be code-split (they all are). */
export function registerColorProviders(factory: (info: SchemaMapInfo) => Promise<ClientColorProvider[]>): void {
    state().colorProviderFactories.push(factory);
}

export async function getAllProviders(info: SchemaMapInfo): Promise<ClientColorProvider[]> {
    const results = await Promise.all(state().colorProviderFactories.map(f => f(info)));
    return results.filter(ps => !!ps).flatMap(ps => ps).filter(p => !!p);
}
