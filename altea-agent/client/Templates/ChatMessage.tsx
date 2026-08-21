import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { NumberLine } from "@altea/altea/client/Lines/NumberLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ChatMessageEntity, ChatMessageRoleEnum, UserFeedbackEnum } from "../../data/ChatSession";
import { ChatbotClient } from "../ChatbotClient";
import { MarkdownOrJson } from "../Message";

// Port of Signum.Agent's Templates/ChatMessage.tsx — one message, read-only, with its content rendered as
// markdown (or formatted JSON for a tool result). altea divergences: the unused `HtmlEditorLine` /
// `react-markdown` imports Signum leaves in the file are dropped, and the tool-call table is a @part-row
// EntityTable rather than an MList one.
export default function ChatMessage(p: { ctx: TypeContext<ChatMessageEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ formGroupStyle: "Basic", readOnly: true });

    return (
        <div>
            <div className="row">
                <div className="col-sm-4">
                    <EntityLine ctx={ctx4.subCtx(n => n.chatSession)} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.creationDate)} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.role)} />
                </div>
            </div>

            <div className="row">
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.languageModel)} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.duration)} />
                </div>
            </div>

            <div className="row">
                <div className="col-sm-3">
                    <NumberLine ctx={ctx4.subCtx(n => n.inputTokens)} />
                </div>
                <div className="col-sm-3">
                    <NumberLine ctx={ctx4.subCtx(n => n.cachedInputTokens)} />
                </div>
                <div className="col-sm-3">
                    <NumberLine ctx={ctx4.subCtx(n => n.outputTokens)} />
                </div>
                <div className="col-sm-3">
                    <NumberLine ctx={ctx4.subCtx(n => n.reasoningOutputTokens)} />
                </div>
            </div>

            {ctx.value.role === ChatMessageRoleEnum.Tool ? (
                <>
                    <div className="row">
                        <div className="col-sm-3">
                            <AutoLine ctx={ctx4.subCtx(n => n.toolCallID)} />
                        </div>
                        <div className="col-sm-3">
                            <AutoLine ctx={ctx4.subCtx(n => n.toolID)} />
                        </div>
                        <div className="col-sm-6">
                            <EntityLine ctx={ctx4.subCtx(n => n.exception)} />
                        </div>
                    </div>
                    <MarkdownOrJson content={ctx4.value.content} />
                </>
            ) : (
                <>
                    {ctx4.value.reasoningContent &&
                        <FormGroup ctx={ctx4.subCtx(n => n.reasoningContent)}>
                            {() => ChatbotClient.Options.renderMarkdown(ctx4.value.reasoningContent!)}
                        </FormGroup>}

                    <FormGroup ctx={ctx4.subCtx(n => n.content)}>
                        {() => ctx4.value.content ? ChatbotClient.Options.renderMarkdown(ctx4.value.content) : undefined}
                    </FormGroup>

                    {ctx.value.role === ChatMessageRoleEnum.Assistant && ctx4.value.toolCalls.length > 0 &&
                        <EntityTable ctx={ctx4.subCtx(n => n.toolCalls)} columns={[
                            { property: a => a.callId },
                            { property: a => a.toolId },
                            { property: a => a.arguments, template: tctx => <MarkdownOrJson content={tctx.value.arguments} /> },
                        ]} />}

                    {ctx.value.role === ChatMessageRoleEnum.Assistant
                        && (ctx.value.userFeedback != null || ctx.value.userFeedbackMessage != null) && (
                            <div className="row mt-2">
                                <div className="col-sm-3">
                                    <AutoLine ctx={ctx4.subCtx(n => n.userFeedback)} />
                                </div>
                                {ctx.value.userFeedback === UserFeedbackEnum.Negative && (
                                    <div className="col-sm-9">
                                        <AutoLine ctx={ctx4.subCtx(n => n.userFeedbackMessage)} />
                                    </div>
                                )}
                            </div>
                        )}
                </>
            )}
        </div>
    );
}
