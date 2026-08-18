import * as React from "react";
import { Navigator } from "@altea/altea/client/Navigator";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import type { EntityOmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import { OmniboxProvider } from "./OmniboxProvider";

// Port of Signum's `EntityOmniboxProvider` (Signum.Omnibox/EntityOmniboxProvider.tsx): renders the
// "jump straight to one entity" rows — `Order 5` / `Customer "Maria"` — and navigates to the entity view.
export default class EntityOmniboxProvider extends OmniboxProvider<EntityOmniboxResult> {

    getProviderName(): string {
        return OmniboxResultTypeName.Entity;
    }

    icon(): React.ReactElement {
        return this.coloredIcon("arrow-circle-right", "#BCDEFF");
    }

    renderItem(result: EntityOmniboxResult): React.ReactNode[] {

        const array: React.ReactNode[] = [];

        array.push(this.icon());

        this.renderMatch(result.typeMatch, array);
        array.push(<span> </span>);

        if (result.id == undefined && result.toStr == undefined) {
            throw Error("Invalid EntityOmniboxProvider result");
        } else {

            if (result.id != undefined) {
                array.push(`${result.id}: `);

                if (result.lite == undefined) {
                    array.push(this.coloredSpan(OmniboxMessage.NotFound.niceToString(), "gray"));
                } else {
                    array.push(result.lite.toString());
                }
            } else {
                if (result.lite == undefined) {
                    array.push(`'${result.toStr}': `);
                    array.push(this.coloredSpan(OmniboxMessage.NotFound.niceToString(), "gray"));
                } else {

                    // A guid id is unreadable in full — show only its head and tail (Signum does the same).
                    // altea: `fields`, not Signum's capitalized `members["Id"]`; the PK kind lives in
                    // columnOptions.
                    const ti = tryGetTypeInfo(result.typeMatch.text);
                    const pk = ti?.fields["id"]?.columnOptions?.primaryKey;
                    if (pk === "uuid" || pk === "uuid7") {
                        const id = result.lite.id as string;
                        array.push(<span className="guid">{id.substring(0, 4) + "…" + id.substring(id.length - 4)}</span>);
                    } else {
                        // ALTEA FIX: Signum pushed `result.id` here, which is always undefined in this
                        // branch (it is the ToStr branch) — the id came out blank. The lite carries it.
                        array.push(result.lite.id);
                    }

                    array.push(": ");
                    if (result.toStrMatch != undefined)
                        this.renderMatch(result.toStrMatch, array);
                }
            }
        }

        return array;
    }

    navigateTo(result: EntityOmniboxResult): Promise<string> | undefined {

        if (result.lite == undefined)
            return undefined;

        return Promise.resolve(Navigator.navigateRoute(result.lite));
    }

    toString(result: EntityOmniboxResult): string {
        if (result.id != undefined)
            return `${result.typeMatch.text} ${result.id}`;

        if (result.toStr)
            return `${result.typeMatch.text} "${result.toStr}"`;

        return result.typeMatch.text;
    }
}
