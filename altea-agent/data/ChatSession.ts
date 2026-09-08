import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { backReference, column, entity, part, quoted, rowOrder, serialize } from "@altea/altea/data/decorators";
import { validate, stringLengthValidator, noRepeatValidator, ValidationMessage } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import type { int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { DeleteSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { ChatbotLanguageModelEntity } from "./LanguageModel";

// Port of Signum.Agent's ChatSession.cs — the persisted conversation: one ChatSessionEntity per chat, one
// ChatMessageEntity per turn (system prompt, user question, assistant answer, tool result), with token
// counts and per-message duration so cost is queryable.
//
// altea divergences, documented inline:
//  - `MList<ToolCallEmbedded> ToolCalls` → the `ChatMessageEntity_ToolCall` @part row below (altea has no
//    MList). `[PreserveOrder]` is the row's `@rowOrder`, `[NoRepeatValidator]` is kept.
//  - `DateTime` → `Temporal.PlainDateTime`; `TimeSpan? Duration` → `Temporal.Duration | null`.
//  - the client-only `_response` back-pointer (which Signum declares by widening the generated interface
//    in Signum.Agent.ts) is a real field here, marked `@column(false) @serialize(false)`: the chat modal
//    pairs a tool RESULT message with the CALL that produced it, and altea has one shared class rather
//    than a server class plus a client interface to widen.

/** Signum's ChatMessageRole. */
export enum ChatMessageRole {
    /** Prompts. */
    System,
    /** The user's question. */
    User,
    /** The model's answer (possibly a tool call). */
    Assistant,
    /** A tool's result. */
    Tool,
}

/** Signum's UserFeedback — the thumbs up/down on an assistant answer. */
export enum UserFeedback {
    Positive,
    Negative,
}

@reflect
@entity("System", "Transactional")
export class ChatSessionEntity extends Entity {

    title: string | null = null;

    languageModel: Lite<ChatbotLanguageModelEntity>;

    user: Lite<UserEntity>;

    startDate: Temporal.PlainDateTime;

    totalInputTokens: int | null = null;
    totalOutputTokens: int | null = null;
    totalCachedInputTokens: int | null = null;
    totalReasoningOutputTokens: int | null = null;
    totalToolCalls: int;

    @quoted
    toString(): string {
        return this.title ?? `ChatSession ${this.id ?? "New"}`;
    }
}

export namespace ChatSessionOperation {
    export const Delete: DeleteSymbol<ChatSessionEntity> = init();
}

@reflect
@entity("System", "Transactional")
export class ChatMessageEntity extends Entity {

    chatSession: Lite<ChatSessionEntity>;

    creationDate: Temporal.PlainDateTime = Clock.now;

    role: ChatMessageRole;

    /** The message text — or, for a Tool row, the tool's serialized result. */
    @validate<ChatMessageEntity>(m =>
        m.content == null && m.role !== ChatMessageRole.Assistant && m.exception == null
            ? ValidationMessage._0IsNotSet.niceToString(ChatMessageEntity.nicePropertyName(a => a.content))
            : null)
    @stringLengthValidator({ multiLine: true })
    content: string | null = null;

    @validate<ChatMessageEntity>(m =>
        m.reasoningContent != null && m.role !== ChatMessageRole.Assistant
            ? ValidationMessage._0ShouldBeNull.niceToString(ChatMessageEntity.nicePropertyName(a => a.reasoningContent))
            : null)
    @stringLengthValidator({ multiLine: true })
    reasoningContent: string | null = null;

    @noRepeatValidator()
    toolCalls: ChatMessageEntity_ToolCall[];

    /** Set on a Tool row: which call this is the answer to. */
    @validate<ChatMessageEntity>(m =>
        m.toolCallID != null && m.role !== ChatMessageRole.Tool
            ? ValidationMessage._0ShouldBeNull.niceToString(ChatMessageEntity.nicePropertyName(a => a.toolCallID))
            : null)
    @stringLengthValidator({ max: 100 })
    toolCallID: string | null = null;

    @validate<ChatMessageEntity>(m =>
        m.toolID != null && m.role !== ChatMessageRole.Tool
            ? ValidationMessage._0ShouldBeNull.niceToString(ChatMessageEntity.nicePropertyName(a => a.toolID))
            : null)
    @stringLengthValidator({ max: 100 })
    toolID: string | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    languageModel: Lite<ChatbotLanguageModelEntity> | null = null;

    inputTokens: int | null = null;
    cachedInputTokens: int | null = null;
    outputTokens: int | null = null;
    reasoningOutputTokens: int | null = null;

    duration: Temporal.Duration | null = null;

    @validate<ChatMessageEntity>(m =>
        m.userFeedback != null && m.role !== ChatMessageRole.Assistant
            ? ValidationMessage._0ShouldBeNull.niceToString(ChatMessageEntity.nicePropertyName(a => a.userFeedback))
            : null)
    userFeedback: UserFeedback | null = null;

    @validate<ChatMessageEntity>(m =>
        m.userFeedbackMessage != null && m.userFeedback !== UserFeedback.Negative
            ? ValidationMessage._0ShouldBeNull.niceToString(ChatMessageEntity.nicePropertyName(a => a.userFeedbackMessage))
            : null)
    @stringLengthValidator({ max: 1000, multiLine: true })
    userFeedbackMessage: string | null = null;

    // No `toString()`: Signum's ChatMessageEntity does not override it either, so its table has no ToStr
    // column and the display falls back to Entity's own "<nice name> <id>". The obvious string here
    // ("User 12") reads the ROLE through its enum NAME, which no query can expand inline — so keeping it
    // would mean materialising a `to_str` column Signum does not have. Inherit the default instead.
}

export namespace ChatMessageOperation {
    export const Delete: DeleteSymbol<ChatMessageEntity> = init();
}

/** Signum's `MList<ToolCallEmbedded>` on ChatMessageEntity, as this owner's @part row. */
@reflect
@part("Transactional")
export class ChatMessageEntity_ToolCall extends Entity {
    @backReference chatMessage: Lite<ChatMessageEntity>;
    @rowOrder order: int;

    /** The provider's call id — how a Tool row finds the call it answers. */
    @stringLengthValidator({ max: 100 })
    callId: string;

    @stringLengthValidator({ max: 100 })
    toolId: string;

    /** The arguments the model produced, as JSON. */
    @stringLengthValidator({ multiLine: true })
    arguments: string;

    /** A UI tool: the server never runs it, the client answers it (see ChatbotClient.registerUITool). */
    isUITool: boolean;

    /**
     * CLIENT-ONLY: the Tool message that answered this call, paired up in the chat modal. Not a column and
     * not serialized — Signum expresses the same thing by widening its generated interface.
     */
    @column(false) @serialize(false)
    _response: ChatMessageEntity | null = null;

    toString(): string {
        return `${this.toolId} (${this.callId})`;
    }
}

export const ChatbotMessage = {
    OpenSession: msg("Open session"),
    NewSession: msg("New session"),
    Send: msg(),
    TypeAMessage: msg("Type a message..."),
    InitialInstruction: msg("Initial instruction"),
    ShowSystem: msg("Show system"),
    UnableToChangeModelOrProviderOnceUsed: msg("Unable to change Model or Provider once used"),
    WhatWentWrong: msg("What went wrong? (optional)"),
    ProvideFeedback: msg("Provide feedback"),
    Price: msg(),
    TotalPrice: msg("Total price"),
    AnswerAbovePlease: msg("Answer above please"),
    MessageMustBeTheLastToDelete: msg("Message must be the last to delete"),
    SessionInterruptedDoYouWantToRecover: msg("Session interrupted, do you want to recover?"),
    Recover: msg(),
    Reasoning: msg(),
};

export namespace ChatbotPermission {
    export const UseChatbot: PermissionSymbol = init();
}
