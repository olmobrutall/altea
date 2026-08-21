import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { ChatbotMessage, ChatMessageEntity, ChatMessageRoleEnum, ChatSessionEntity } from "../../data/ChatSession";

// Port of Signum.Agent's Templates/ChatSession.tsx — the session header plus two search tabs over its
// messages: the TRANSCRIPT and the token/price breakdown.
//
// altea divergences:
//  - the price tab drops the `expression<number>("Price")` columns: altea does not register `Price` /
//    `TotalPrice` as query expressions (see server/ChatbotLogic.ts's header for why), so the tab shows the
//    raw token counts with their sums, which is what those columns are computed from.
//  - `token(a => a.entity.toolCalls)` → `token(a => a.toolCalls)`: altea tokens are ROOTLESS.
export default function ChatSession(p: { ctx: TypeContext<ChatSessionEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div>
            <AutoLine ctx={ctx4.subCtx(n => n.title)} />

            <div className="row">
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.languageModel)} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.user)} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.startDate)} />
                </div>
            </div>

            <Tabs id={ctx.prefix + "tabs"}>
                <Tab title={ChatMessageEntity.nicePluralName()} eventKey="messages">
                    <SearchControl findOptions={ChatMessageEntity.findOptions(token => ({
                        filterOptions: [
                            token(a => a.chatSession).filter("EqualTo", ctx.value.toLite(), { frozen: true }),
                            token(a => a.role).filter("DistinctTo", ChatMessageRoleEnum.System, {
                                pinned: { active: "NotCheckbox_Unchecked", column: 1, label: ChatbotMessage.ShowSystem.niceToString() },
                            }),
                        ],
                        columnOptionsMode: "ReplaceAll",
                        columnOptions: [
                            token(a => a.id),
                            token(a => a.role),
                            token(a => a.toolID),
                            token(a => a.toolCalls).count().column({ displayName: "# Tools" }),
                            token(a => a.content),
                            token(a => a.exception),
                        ],
                        orderOptions: [token(a => a.id).order("Ascending")],
                    }))} />
                </Tab>

                <Tab title={ChatbotMessage.Price.niceToString()} eventKey="stats">
                    <SearchControl findOptions={ChatMessageEntity.findOptions(token => ({
                        filterOptions: [token(a => a.chatSession).filter("EqualTo", ctx.value.toLite(), { frozen: true })],
                        columnOptionsMode: "ReplaceAll",
                        columnOptions: [
                            token(a => a.id),
                            token(a => a.role),
                            token(a => a.toolID),
                            token(a => a.toolCalls).count().column({
                                displayName: "# Tools",
                                summaryToken: token(a => a.toolCalls).count().sum(),
                            }),
                            token(a => a.inputTokens).column({ summaryToken: token(a => a.inputTokens).sum() }),
                            token(a => a.cachedInputTokens).column({ summaryToken: token(a => a.cachedInputTokens).sum() }),
                            token(a => a.outputTokens).column({ summaryToken: token(a => a.outputTokens).sum() }),
                            token(a => a.reasoningOutputTokens).column({ summaryToken: token(a => a.reasoningOutputTokens).sum() }),
                        ],
                        orderOptions: [token(a => a.id).order("Ascending")],
                    }))} />
                </Tab>
            </Tabs>
        </div>
    );
}
