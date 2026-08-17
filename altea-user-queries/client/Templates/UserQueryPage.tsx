import * as React from "react";
import { useState } from "react";
import { useParams } from "react-router";
import { Navigator } from "@altea/altea/client/Navigator";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { getQueryNiceName, newLite } from "@altea/altea/client/Reflection";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Enum } from "@altea/altea/data/enum";
import { RefreshModeEnum } from "@altea/altea/data/dynamicQueries";
import { UserQueryEntity } from "../../data/UserQuery";
import { UserQueriesClient } from "../UserQueriesClient";

// Port of Signum's Signum.UserQueries/Templates/UserQueryPage.tsx. Fetches the UserQuery, builds its
// FindOptions, and runs it in a full SearchControl. altea divergences: no onResize max-height tuning
// (SearchPage-specific) and no `fillLiteModels` for the current entity (best-effort — deferred).
export default function UserQueryPage(): React.JSX.Element | null {
    const params = useParams() as { userQueryId: string; entity?: string };
    const { userQueryId, entity } = params;

    const [currentUserQuery, setCurrentUserQuery] = useState<UserQueryEntity | null>(null);
    const [currentEntity, setCurrentEntity] = useState<Lite<Entity> | null>(null);

    const fo = useAPI<FindOptions | undefined>(() =>
        Navigator.API.fetch(newLite(UserQueryEntity, userQueryId) as Lite<UserQueryEntity>)
            .then(uq => {
                setCurrentUserQuery(uq);
                const lite = entity == undefined ? undefined : Lite.parse(entity);
                setCurrentEntity(lite ?? null);
                return UserQueriesClient.Converter.toFindOptions(uq, lite);
            }),
        [userQueryId, entity]);

    useTitle(fo == null ? "…"
        : getQueryNiceName(fo.queryName) + (currentUserQuery ? " - " + currentUserQuery.displayName : ""));

    if (fo == undefined || currentUserQuery == null)
        return null;

    return (
        <div id="divSearchPage" className="sf-search-page">
            <h1 className="display-6 sf-query-title h3 d-flex align-items-center">
                <span>{getQueryNiceName(fo.queryName)}</span>
                <small className="sf-type-nice-name text-muted ms-2">- {currentUserQuery.displayName}</small>
            </h1>

            <SearchControl
                defaultIncludeDefaultFilters={true}
                findOptions={fo}
                tag="UserQueryPage"
                throwIfNotFindable={true}
                showBarExtension={true}
                largeToolbarButtons={true}
                showGroupButton={true}
                showSystemTimeButton={true}
                showFooter={true}
                extraOptions={{
                    userQuery: newLite(UserQueryEntity, userQueryId),
                    entity: currentEntity ?? undefined,
                }}
                defaultRefreshMode={Enum.toName(RefreshModeEnum, currentUserQuery.refreshMode)}
                searchOnLoad={Enum.toName(RefreshModeEnum, currentUserQuery.refreshMode) === "Auto"}
            />
        </div>
    );
}
