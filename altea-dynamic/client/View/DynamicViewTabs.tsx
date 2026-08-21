import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import JavascriptCodeMirror from "@altea/altea-codemirror/client/JavascriptCodeMirror";
import type { DesignerNode } from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import { DynamicViewTree } from "./DynamicViewTree";
import { DynamicViewInspector, PropsHelp } from "./Designer";
import { ModulesHelp } from "./ModulesHelp";
import type { DynamicViewEntity } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/DynamicViewTabs.tsx — verbatim: the designer's three tabs. "Render" is the
// tree plus the inspector for the selected node; "Props" declares what the view can be passed; "Locals" is
// the hook body whose result every expression sees as `locals`.
export function DynamicViewTabs(
    { ctx, rootNode }: { ctx: TypeContext<DynamicViewEntity>; rootNode: DesignerNode<BaseNode> },
): React.JSX.Element {

    const typeName = rootNode.route?.type.getTypeName() ?? "Entity";
    const handleChange = (): void => rootNode.context.refreshView();

    return (
        <Tabs id="dynamicView_dropdown" mountOnEnter={true}>
            <Tab eventKey="render" title="Render">
                <DynamicViewTree rootNode={rootNode} />
                <DynamicViewInspector selectedNode={rootNode.context.getSelectedNode()} />
            </Tab>
            <Tab eventKey="props" title="Props">
                <EntityTable ctx={ctx.subCtx(a => a.props)} onChange={handleChange}
                    columns={[
                        { property: a => a.name, template: sctx => <AutoLine ctx={sctx.subCtx(a => a.name)} onChange={handleChange} /> },
                        { property: a => a.type, template: sctx => <AutoLine ctx={sctx.subCtx(a => a.type)} onChange={handleChange} /> },
                    ]} />
            </Tab>
            <Tab eventKey="locals" title="Locals">
                <div className="code-container">
                    <pre style={{ border: "0px", margin: "0px", overflow: "visible" }}>
                        {"(ctx: TypeContext<" + typeName + ">, "}
                        <div style={{ display: "inline-flex" }}>
                            <ModulesHelp cleanName={typeName.replace(/Entity$/, "")} />{", "}
                            <PropsHelp node={rootNode} />{") =>"}
                        </div>
                    </pre>
                    <JavascriptCodeMirror code={ctx.value.locals ?? ""}
                        onChange={newCode => { ctx.value.locals = newCode; handleChange(); }} />
                </div>
            </Tab>
        </Tabs>
    );
}
