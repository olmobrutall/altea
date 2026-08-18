import * as React from "react";
import type { Location } from "react-router";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { useAPI } from "@altea/altea/client/Hooks";
import { ToolbarConfig } from "@altea/altea-toolbar/client/ToolbarConfig";
import { SearchToolbarCount, ToolbarCount } from "@altea/altea-toolbar/client/QueryToolbarConfig";
import type { ToolbarResponse } from "@altea/altea-toolbar/data/ToolbarResponse";
import type { ShowCount } from "@altea/altea-toolbar/data/Toolbar";
import { UserQueryEntity } from "../data/UserQuery";
import { UserQueriesClient } from "./UserQueriesClient";

// Faithful port of Signum's UserQueryToolbarConfig.tsx (Signum.UserQueries/UserQueryToolbarConfig.tsx): the
// toolbar config for an element pointing at a saved USER QUERY — it navigates to the user-query URL (carrying
// the selected entity when the menu is entity-scoped), can open the results in a modal, and shows a live count.
//
// It lives HERE (with the user-query module, not with the toolbar) exactly as in Signum: the toolbar knows
// nothing about user queries; user queries know about the toolbar.
//
// altea divergences: import paths, `liteKey(x)` → `x.key()`, and `UserQueryClient` → `UserQueriesClient`.

export default class UserQueryToolbarConfig extends ToolbarConfig<UserQueryEntity> {
    constructor() {
        const type = UserQueryEntity;
        super(type);
    }

    override getCounter(element: ToolbarResponse<UserQueryEntity>, entity: Lite<Entity> | null): React.ReactElement | undefined {

        if (element.showCount != null) {
            return <SearchUserQueryCount userQuery={element.content!}
                entity={entity}
                color={element.iconColor}
                autoRefreshPeriod={element.autoRefreshPeriod}
                showCount={element.showCount} />;
        }

        return undefined;
    }

    getDefaultIcon(): IconProp {
        return "rectangle-list";
    }

    override async selectSubEntityForUrl(element: ToolbarResponse<UserQueryEntity>, entity: Lite<Entity> | null): Promise<Lite<Entity> | undefined> {
        const userQuery = await Navigator.API.fetch(element.content!);
        return selectSubEntity(userQuery, entity ?? undefined);
    }

    override handleNavigateClick(e: React.MouseEvent<any> | undefined, res: ToolbarResponse<UserQueryEntity>, selectedEntity: Lite<Entity> | null): void {
        if (!res.openInPopup)
            super.handleNavigateClick(e, res, selectedEntity);
        else {
            Navigator.API.fetch(res.content!)
                .then(uq => UserQueriesClient.Converter.toFindOptions(uq, selectedEntity ?? undefined)
                    .then(fo => Finder.explore(fo)));
        }
    }

    navigateTo(res: ToolbarResponse<UserQueryEntity>, selectedEntity: Lite<Entity> | null): Promise<string> {
        return Navigator.API.fetch(res.content!)
            .then(uq => UserQueriesClient.getUserQueryUrl(uq, selectedEntity ?? undefined));
    }

    isCompatibleWithUrlPrio(res: ToolbarResponse<UserQueryEntity>, location: Location, query: any, entityType?: string): { prio: number, inferredEntity?: Lite<Entity> } | null {
        if (query["userQuery"] == res.content!.key()) {
            return { prio: 2, inferredEntity: query["entity"] && Lite.parse(query["entity"]) };
        }
        return null;
    }
}

/** Signum's `selectSubEntity`: run the user query and let the caller pick ONE of its results — the entity a
 *  `:id2`-style url placeholder needs. */
export async function selectSubEntity(uq: UserQueryEntity, entity: Lite<Entity> | undefined): Promise<Lite<Entity> | undefined> {

    const fo = await UserQueriesClient.Converter.toFindOptions(uq, entity ?? undefined);
    const lites = await Finder.fetchLites({ queryName: fo.queryName, filterOptions: fo.filterOptions ?? [] });
    if (lites.length == 0) {
        return await Finder.find(fo);
    }

    const onlyType = lites.map(a => a.entityType).distinctBy(a => a.name).single();
    return await SelectorModal.chooseLite(onlyType, lites);
}

interface CountUserQueryIconProps {
    userQuery: Lite<UserQueryEntity>;
    entity: Lite<Entity> | null;
    color?: string;
    autoRefreshPeriod?: number;
    showCount: ShowCount;
}

export function SearchUserQueryCount(p: CountUserQueryIconProps): React.JSX.Element {

    const userQuery = Navigator.useFetchInState(p.userQuery);
    const findOptions = useAPI(() => userQuery ? UserQueriesClient.Converter.toFindOptions(userQuery, p.entity ?? undefined) : Promise.resolve(undefined), [userQuery, p.entity]);

    if (findOptions == null)
        return <ToolbarCount num={undefined} showCount={p.showCount} />;

    return <SearchToolbarCount findOptions={findOptions} autoRefreshPeriod={p.autoRefreshPeriod} color={p.color} showCount={p.showCount} />;
}
