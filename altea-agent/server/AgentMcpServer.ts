import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { UserHolder } from "@altea/altea/server/userHolder";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { Serializer } from "@altea/altea/data/serializer";
import type { AgentSymbol } from "../data/SkillCustomization";
import { AgentLogic } from "./AgentLogic";
import type { SkillCode } from "./SkillCode";
import { describeToolName } from "./Skills/IntroductionSkill";

// Port of Signum.Agent's `SignumMcpServerBuilderExtensions.WithSignumSkill(builder, useCase)` (AgentLogic.cs)
// — the same skill tree, exposed to an EXTERNAL MCP host (Claude Desktop, an IDE, another agent) instead of
// to the built-in chat modal.
//
// Signum builds this on the `ModelContextProtocol.AspNetCore` package's `IMcpServerBuilder`; the port builds
// it on `@modelcontextprotocol/sdk` — the same protocol's official JavaScript implementation, which is why
// this is an SDK dependency rather than another hand-built substrate. The logic Signum writes on top is
// unchanged, and it is the interesting part:
//
//   - a SESSION starts with only the EAGER skills activated;
//   - `tools/list` reports the activated skills' tools;
//   - `tools/call` invokes one, and when the call was `Describe`, the named skill's eager subtree is added
//     to the session's activated set and a `notifications/tools/list_changed` goes out — so a lazy skill
//     genuinely appears mid-session.
//
// altea divergences, documented inline:
//  - `AgentLogic.IsMCP` (an AsyncThreadVariable a tool could branch on) is not ported: no ported skill reads
//    it. `mcpSessionsStarted` below is the diagnostic that was worth keeping.
//  - `RunSessionHandler` (an experimental Signum hook, `MCPEXP002`) is not needed: the transport's own
//    session callbacks (`onsessioninitialized` / `onsessionclosed`) are where the activated set is seeded
//    and dropped.
//  - a tool call runs in `Transaction.forceNew`, because an MCP request is not an altea HTTP request and
//    carries no ambient transaction (the same reason the ConcurrentUser hub methods open their own).
//  - `MCPExceptionLoggerProvider` — Signum's `ILoggerProvider` that funnels the MCP library's error-level
//    logs into ExceptionLogic — has no counterpart: the SDK does not log through an injectable provider, and
//    every throw already passes through the call handler below, which is where the logging belongs.
export namespace AgentMcpServer {

    /** The MCP sessions this process has served, for the diagnostics Signum's IsMCP flag hinted at. */
    export let sessionsStarted = 0;

    /**
     * Whether an unauthenticated request is refused (see the note in `handle`). Left ON; a deployment that
     * fronts the endpoint with its own gateway authentication can turn it off deliberately.
     */
    export let requireAuthentication = true;

    /**
     * Mounts the MCP endpoint. `agent` names which agent's skill tree is exposed — Southwind uses a
     * DEDICATED agent for MCP (`SouthwindAgentUseCases.MCP`, all sub-skills Lazy), separate from the
     * chatbot's, so an external host discovers tools progressively.
     */
    export function start(ws: WebBuilder, agent: AgentSymbol, path = "/api/mcp"): void {

        // Per-MCP-session state: the transport instance and the set of activated skill names.
        const sessions = new Map<string, { transport: StreamableHTTPServerTransport; activated: Set<string> }>();

        const getRoot = (): Promise<SkillCode> => AgentLogic.getEffectiveSkillCode(agent);

        const activatedNames = async (sessionId: string | undefined): Promise<Set<string>> => {
            const session = sessionId == undefined ? undefined : sessions.get(sessionId);
            if (session != undefined)
                return session.activated;
            // Stateless request (no session id): the eager set, which is what a fresh session would hold.
            return new Set([...(await getRoot()).getEagerSkillsRecursive()].map(s => s.name));
        };

        const buildServer = (getSessionId: () => string | undefined): Server => {
            const server = new Server(
                { name: "altea-agent", version: "1.0.0" },
                { capabilities: { tools: { listChanged: true } } });

            server.setRequestHandler(ListToolsRequestSchema, async () => {
                const root = await getRoot();
                const activated = await activatedNames(getSessionId());

                const tools = [...activated]
                    .map(name => root.findSkill(name))
                    .filter((s): s is SkillCode => s != undefined)
                    .flatMap(s => s.getTools())
                    // A UI tool has no server body: an external host has no chat modal to answer it in.
                    .filter(t => t.isUITool !== true)
                    .map(t => ({
                        name: t.name,
                        description: t.description ?? "",
                        inputSchema: t.parameters as { type: "object" },
                        ...(t.destructive === true ? { annotations: { destructiveHint: true } } : {}),
                    }));

                return { tools };
            });

            server.setRequestHandler(CallToolRequestSchema, async request => {
                const toolName = request.params.name;
                const root = await getRoot();
                const activated = await activatedNames(getSessionId());

                const tool = [...activated]
                    .map(name => root.findSkill(name))
                    .filter((s): s is SkillCode => s != undefined)
                    .flatMap(s => s.getTools())
                    .find(t => t.name === toolName);

                if (tool == undefined)
                    throw new Error(`Tool '${toolName}' not found`);
                if (tool.invoke == undefined)
                    throw new Error(`Tool '${toolName}' is a UI tool and cannot be invoked over MCP`);

                const args = (request.params.arguments ?? {}) as Record<string, unknown>;

                let result: unknown;
                try {
                    using _prof = HeavyProfiler.log("Mcp.Tool", () => toolName);
                    result = await Transaction.forceNew(() => tool.invoke!(args));
                } catch (e) {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
                    };
                }

                // Signum's post-call hook: a successful `Describe` unlocks that skill's eager subtree for
                // the rest of the session, and the host is told the tool list changed.
                const sessionId = getSessionId();
                const session = sessionId == undefined ? undefined : sessions.get(sessionId);
                if (toolName === describeToolName && session != undefined) {
                    const skillName = args["skillName"];
                    const newSkill = typeof skillName === "string" ? root.findSkill(skillName) : undefined;
                    if (newSkill != undefined) {
                        for (const s of newSkill.getEagerSkillsRecursive())
                            session.activated.add(s.name);
                        await server.sendToolListChanged();
                    }
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: typeof result === "string" ? result : Serializer.stringify(result ?? null),
                    }],
                };
            });

            return server;
        };

        // The Streamable HTTP transport uses all three verbs on one path: POST for requests, GET for the
        // server→client SSE stream, DELETE to close the session.
        const handle = async (req: Request, res: Response): Promise<void> => {
            // AUTHENTICATION, and a divergence worth stating: these routes are mounted straight on Express, so
            // the typed wrapper's authorization gate (`setAuthorizeRequest`) never sees them — but altea's auth
            // middleware IS a global `app.use`, so a request carrying `Authorization: Bearer <token>` arrives
            // with its user resolved. Signum leaves the policy to ASP.NET and Southwind adds none, which makes
            // its endpoint open; altea REFUSES an unauthenticated one instead, because these tools construct,
            // execute and delete entities. An MCP host authenticates with an altea bearer token.
            if (requireAuthentication && UserHolder.current() == undefined) {
                res.status(401).json({ error: "The MCP endpoint requires an authenticated user (Authorization: Bearer <token>)" });
                return;
            }

            const sessionId = req.headers["mcp-session-id"] as string | undefined;
            const existing = sessionId == undefined ? undefined : sessions.get(sessionId);

            if (existing != undefined) {
                await existing.transport.handleRequest(req, res, (req as { body?: unknown }).body);
                return;
            }

            // A request with an unknown session id on GET/DELETE is over; only a POST can open one.
            if (req.method !== "POST") {
                res.status(404).json({ error: "Unknown MCP session" });
                return;
            }

            let created: { transport: StreamableHTTPServerTransport; activated: Set<string> } | undefined;

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: async id => {
                    const activated = new Set([...(await getRoot()).getEagerSkillsRecursive()].map(s => s.name));
                    created = { transport, activated };
                    sessions.set(id, created);
                    sessionsStarted++;
                },
                onsessionclosed: id => { sessions.delete(id); },
            });

            const server = buildServer(() => transport.sessionId);
            await server.connect(transport);
            await transport.handleRequest(req, res, (req as { body?: unknown }).body);
        };

        // Mounted straight on Express, not through `ws.get/post`: MCP owns its own JSON-RPC envelope, its own
        // content negotiation and its own SSE framing, none of which the typed wrapper should touch.
        ws.app.post(path, (req, res) => { void handle(req as Request, res as Response); });
        ws.app.get(path, (req, res) => { void handle(req as Request, res as Response); });
        ws.app.delete(path, (req, res) => { void handle(req as Request, res as Response); });
    }
}
