import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { BasicPermission, TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import type { SchemaMapInfo } from "../../data/Map";
import type { ClientColorProvider } from "./ClientColorProvider";

// Port of Signum.Map's Schema/AuthColorProvider.tsx — the client half of the per-role colourings the
// server's AuthColorProvider announces. It computes no rules: it only turns the band names the server put
// in `table.extra` into a linear gradient, so a table whose access varies by row CONDITION reads as a
// striped box (fallback band first, then one per condition rule).
//
// The gradients are declared ONCE, on the first provider's `defs` — one `<linearGradient>` per distinct
// band string across every role — and each provider then references them by id through `url(#…)`.
//
// altea divergences:
//  - `isPermissionAuthorized` comes from altea-auth's `AuthClient`, not from core's AppContext: altea's
//    client permission gate lives in the auth module (see AuthClient's own note).
//  - `TypeAllowedBasic` is a NUMERIC enum in altea, so the band name is matched against the enum's member
//    NAME rather than against the union member Signum has.
//  - Signum's `.groupBy(a => a).map(gr => gr.key)` (its own dedupe idiom) is `distinct()`.
export default function getAuthProviders(info: SchemaMapInfo): ClientColorProvider[] {
    if (!AuthClient.isPermissionAuthorized(BasicPermission.AdminRules))
        return [];

    return info.providers.filter(p => p.name.startsWith("role-")).map((p, i) => ({
        name: p.name,
        getFill: t => t.extra[p.name + "-db"] == undefined ? "white" : "url(#" + t.extra[p.name + "-db"] + ")",
        getStroke: t => t.extra[p.name + "-ui"] == undefined ? "white" : "url(#" + t.extra[p.name + "-ui"] + ")",
        getTooltip: t => (t.extra[p.name + "-tooltip"] as string | undefined) ?? "",
        defs: i == 0 ? getDefs(info) : undefined,
    } satisfies ClientColorProvider));
}

function getDefs(info: SchemaMapInfo): React.JSX.Element[] {
    const roles = info.providers.filter(p => p.name.startsWith("role-")).map(a => a.name);

    const distinctValues = info.tables
        .flatMap(t => roles.flatMap(r => [t.extra[r + "-db"] as string, t.extra[r + "-ui"] as string]))
        .filter(a => a != undefined)
        .distinct();

    return distinctValues.map(val => gradient(val));
}

function gradient(name: string): React.JSX.Element {

    const list = name.after("auth-").split("-");

    return (
        <linearGradient key={name} id={name} x1="0%" y1="0%" x2="100%" y2="0%">
            {list.flatMap((l, i) => [
                <stop key={i} offset={(100 * i / list.length) + "%"} stopColor={color(l)} />,
                <stop key={i + "b"} offset={((100 * (i + 1) / list.length) - 1) + "%"} stopColor={color(l)} />,
            ])}
        </linearGradient>
    );
}

/** The band colour for one `TypeAllowedBasic` member name. "Error" is Signum's un-mergeable marker. */
function color(band: string): string {
    switch (band) {
        case TypeAllowedBasic[TypeAllowedBasic.Write]: return "var(--bs-green)";
        case TypeAllowedBasic[TypeAllowedBasic.Read]: return "var(--bs-yellow)";
        case TypeAllowedBasic[TypeAllowedBasic.None]: return "var(--bs-red)";
        case "Error": return "var(--bs-magenta)";
        default: return "var(--bs-body-color)";
    }
}
