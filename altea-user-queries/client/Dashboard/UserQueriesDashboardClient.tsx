import * as React from "react";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { DashboardClient } from "@altea/altea-dashboard/client/DashboardClient";
import { BigValuePartEntity, UserQueryPartEntity, ValueUserQueryListPartEntity } from "../../data/DashboardParts";

// altea's counterpart of the dashboard registrations Signum performs inside UserQueryClient.start (its
// `Navigator.addSettings` + `DashboardClient.registerRenderer` calls for the three UserQuery parts). Kept in
// its own module so the dashboard dependency of @altea/altea-user-queries is visible in ONE place, and so an
// app that does not use dashboards simply never calls it.
//
// Called from UserQueriesClient.start (which is how every other altea client registers its pieces).

export namespace UserQueriesDashboardClient {
    export function start(cb: ClientBuilder): void {

        // The part EDITORS (rendered inside the dashboard grid cell / the part modal).
        cb.configure(UserQueryPartEntity).withView(() => import("./Admin/UserQueryPart"));
        cb.configure(ValueUserQueryListPartEntity).withView(() => import("./Admin/ValueUserQueryListPart"));
        cb.configure(BigValuePartEntity).withView(() => import("./Admin/BigValuePart"));

        // The part VIEWS + how they show up in the "create new part" type selector.
        DashboardClient.registerRenderer(UserQueryPartEntity, {
            component: () => import("./View/UserQueryPart").then(a => a.default),
            icon: () => ({ icon: "list", iconColor: "#4C5052" }),
            defaultTitle: e => e.userQuery?.displayName ?? "",
            getQueryNames: e => e.userQuery == null ? [] : [e.userQuery.query.key],
            waitForInvalidation: true,
        });

        DashboardClient.registerRenderer(ValueUserQueryListPartEntity, {
            component: () => import("./View/ValueUserQueryListPart").then(a => a.default),
            icon: () => ({ icon: "list-check", iconColor: "#EA9E1D" }),
            getQueryNames: e => (e.userQueries ?? []).map(a => a.userQuery.query.key),
        });

        DashboardClient.registerRenderer(BigValuePartEntity, {
            component: () => import("./View/BigValuePart").then(a => a.default),
            icon: () => ({ icon: "cube", iconColor: "#21618C" }),
            withPanel: () => false,
            defaultTitle: e => e.userQuery?.displayName ?? "",
            getQueryNames: e => e.userQuery == null ? [] : [e.userQuery.query.key],
        });
    }
}
