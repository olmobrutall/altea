import * as React from "react";
import { NavDropdown } from "react-bootstrap";
import { useAPI } from "@altea/altea/client/Hooks";
import type { Lite } from "@altea/altea/data/lite";
import { IsolationMessage, type IsolationEntity } from "../data/Isolation";
import { IsolationClient } from "./IsolationClient";

// Port of Signum.Isolation's IsolationDropdown.tsx — the navbar picker. "Global mode" is shown in danger
// red because it is the mode in which nothing is filtered.
//
// ALTEA: Signum sets `data-isolation={name}` on every item, which is the JS global `window.name` — an empty
// string — so the attribute is useless for addressing a specific row. Here each item carries its own lite
// key, which is what an e2e test would select on.
export default function IsolationDropdown(): React.JSX.Element | null {

    const isolations = useAPI(() => IsolationClient.API.isolations(), []);

    if (!isolations)
        return null;

    const current = IsolationClient.getOverridenIsolation();

    function handleSelect(e: React.MouseEvent, c: Lite<IsolationEntity> | undefined): void {
        IsolationClient.changeOverridenIsolation(e, c);
    }

    return (
        <NavDropdown id="isolationDropdown" data-current-isolation={current?.id}
            title={current ? current.toString() : <strong className="text-danger">{IsolationMessage.GlobalMode.niceToString()}</strong>}
            className="sf-isolation-dropdown">
            <NavDropdown.Item data-isolation="" disabled={current == undefined} onClick={e => handleSelect(e, undefined)}>
                {IsolationMessage.GlobalMode.niceToString()}
            </NavDropdown.Item>
            <NavDropdown.Divider />
            {isolations.map((iso, i) =>
                <NavDropdown.Item key={i} data-isolation={iso.key()} disabled={iso.is(current ?? null)} onClick={e => handleSelect(e, iso)}>
                    {iso.toString()}
                </NavDropdown.Item>)}
        </NavDropdown>
    );
}
