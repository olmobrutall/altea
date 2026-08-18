import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import ErrorModal from "@altea/altea/client/Modals/ErrorModal";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { toInt } from "@altea/altea/data/basics";
import { HealthCheckPartEntity_Items, HealthCheckPartEntity, DashboardPartsMessage } from "../../data/Parts";
import type { PartEditorProps } from "./PartEditor";

// Port of Signum's Signum.Dashboard/Admin/HealthCheckPart.tsx — the tile table, plus the "paste health check
// link" shortcut that reads a `title$#$checkUrl$#$navigateUrl` clipboard payload.

export default function HealthCheckPart(p: PartEditorProps<HealthCheckPartEntity>): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ formGroupStyle: "SrOnly", placeholderLabels: true });

    return (
        <div>
            <EntityTable ctx={ctx.subCtx(hc => hc.items)} avoidFieldSet="h6" createAsLink={c =>
                <div>
                    <LinkButton title={c.props.ctx.titleLabels ? EntityControlMessage.Create.niceToString() : undefined}
                        className="sf-line-button sf-create"
                        onClick={c.handleCreateClick}>
                        <FontAwesomeIcon icon="plus" className="sf-create" />&nbsp;{EntityControlMessage.Create.niceToString()}
                    </LinkButton>

                    <LinkButton title={undefined} className="sf-line-button sf-create ms-4"
                        onClick={async () => {
                            const clipboard = await navigator.clipboard.readText();
                            const data = clipboard.split("$#$");
                            if (data.length != 3) {
                                ErrorModal.showErrorModal(new Error(DashboardPartsMessage.ClipboardDataIsNotCompatibleWithHealthCheckData.niceToString()));
                                return;
                            }
                            const item = new HealthCheckPartEntity_Items();
                            item.title = data[0];
                            item.checkURL = data[1];
                            item.navigateURL = data[2];
                            item.order = toInt(ctx.value.items?.length ?? 0);
                            (ctx.value.items ??= []).push(item);
                            forceUpdate();
                        }}>
                        <FontAwesomeIcon aria-hidden={true} icon="heart-pulse" color="gray" /> {DashboardPartsMessage.PasteHealthCheckLink.niceToString()}
                    </LinkButton>
                </div>
            } />
        </div>
    );
}
