import * as React from "react";
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from "@altea/altea/client/ui/Dropdown";
import { useAPI } from "@altea/altea/client/Hooks";
import type { Lite } from "@altea/altea/data/lite";
import { IsolationMessage, type IsolationEntity } from "../data/Isolation";
import { IsolationClient } from "./IsolationClient";

// The navbar picker. "Global mode" is shown in danger red because it is the mode in which nothing is
// filtered.
//
// Each item carries its own LITE KEY in `data-isolation`, which is what an e2e test selects on.
export default function IsolationDropdown(): React.JSX.Element | null {

    const isolations = useAPI(() => IsolationClient.API.isolations(), []);

    if (!isolations)
        return null;

    const current = IsolationClient.getOverridenIsolation();

    function handleSelect(e: React.MouseEvent, c: Lite<IsolationEntity> | undefined): void {
        IsolationClient.changeOverridenIsolation(e, c);
    }

    return (
        <div data-current-isolation={current?.id} className="sf-nav-item sf-dropdown sf-isolation-dropdown">
            <Dropdown>
                <DropdownTrigger asChild>
                    <button type="button" id="isolationDropdown" className="sf-nav-link sf-dropdown-toggle">
                        {current ? current.toString() : <strong className="text-destructive">{IsolationMessage.GlobalMode.niceToString()}</strong>}
                    </button>
                </DropdownTrigger>
                <DropdownContent>
                    <DropdownItem data-isolation="" disabled={current == undefined} onClick={e => handleSelect(e, undefined)}>
                        {IsolationMessage.GlobalMode.niceToString()}
                    </DropdownItem>
                    <DropdownSeparator />
                    {isolations.map((iso, i) =>
                        <DropdownItem key={i} data-isolation={iso.key()} disabled={iso.is(current ?? null)} onClick={e => handleSelect(e, iso)}>
                            {iso.toString()}
                        </DropdownItem>)}
                </DropdownContent>
            </Dropdown>
        </div>
    );
}
