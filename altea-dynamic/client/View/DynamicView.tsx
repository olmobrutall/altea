import * as React from "react";
import { Navigator } from "@altea/altea/client/Navigator";
import type { ViewOverride } from "@altea/altea/client/EntitySettings";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TypeContext, type ButtonsContext, type ButtonBarElement, type IRenderButtons } from "@altea/altea/client/TypeContext";
import { Entity, type BaseEntity } from "@altea/altea/data/entity";
import { JavascriptMessage, SaveChangesMessage } from "@altea/altea/data/uiMessages";
import { Binding } from "@altea/altea/client/binding";
import { resolveType } from "@altea/altea/data/registration";
import { getTypeInfo } from "@altea/altea/client/Reflection";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { DynamicViewTabs } from "./DynamicViewTabs";
import { NodeConstructor, type BaseNode } from "./Nodes";
import { DesignerNode, type DesignerContext, RenderWithViewOverrides } from "./NodeUtils";
import ShowCodeModal from "./ShowCodeModal";
import { DynamicViewEntity, DynamicViewMessage } from "../../data/DynamicView";
import "./DynamicView.css";

// Port of Signum.Dynamic's View/DynamicView.tsx — the DynamicViewEntity's own editor: pick a type, get a
// default node tree, then design against a real EXAMPLE entity you pick with a line. The live preview on the
// right is the same interpreter the entity would get in production, so what you see is what a user gets.
//
// It stays a CLASS component, as in Signum, for one concrete reason: `beforeSave` is called on the frame's
// entityComponent by DynamicViewClient's Save handler, and `renderButtons` is the IRenderButtons contract —
// both need an instance.
//
// altea divergences, documented inline:
//  - `entityType.cleanName` is the TypeEntity's own column, unchanged; but `getTypeInfo(name)` takes a
//    CONSTRUCTOR in altea, so the name is resolved with `resolveType` first.
//  - `props.toObject(a => a.element.name, …)` — no MList wrapper, so the `@part` rows map directly.
//  - `ctx.value.modified = true` is dropped everywhere: altea tracks modification against a SNAPSHOT, so
//    writing the field IS the modification (and there is no `modified` property to set).
//  - `CollapsableTypeHelp` is not ported (see Designer.tsx).
//  - `EntityLine`'s `type={{ name }}` prop does not exist in altea — a Line reads its type from
//    `ctx.memberType` (CLAUDE.md), which the example context already carries through its PropertyRoute.

interface DynamicViewEntityComponentProps {
    ctx: TypeContext<DynamicViewEntity>;
}

interface DynamicViewEntityComponentState {
    exampleEntity: Entity | null;
    rootNode?: BaseNode;
    selectedNode?: DesignerNode<BaseNode>;
    viewOverrides?: ViewOverride<BaseEntity>[];
}

export default class DynamicViewEntityComponent
    extends React.Component<DynamicViewEntityComponentProps, DynamicViewEntityComponentState>
    implements IRenderButtons {

    constructor(props: DynamicViewEntityComponentProps) {
        super(props);
        this.state = { exampleEntity: null };
    }

    handleShowCode = (): void => {
        void ShowCodeModal.showCode(this.props.ctx.value.entityType.cleanName, this.state.rootNode!);
    };

    renderButtons(_bc: ButtonsContext): ButtonBarElement[] {
        return [
            {
                button: <button key="showCode" type="button" className="btn btn-success float-end"
                    disabled={!this.state.rootNode} onClick={this.handleShowCode}>Show code</button>,
            },
        ];
    }

    override componentDidMount(): void {
        this.updateRoot();
    }

    updateStateSelectedNode(newNode: DesignerNode<BaseNode>): void {
        this.setState({ selectedNode: newNode });
    }

    /** Called by DynamicViewClient's Save handler through the frame's entityComponent. */
    beforeSave(): void {
        this.props.ctx.value.viewContent = JSON.stringify(this.state.rootNode!);
    }

    updateRoot(): void {

        const ctx = this.props.ctx;

        if (ctx.value.viewContent == null) {
            this.setState({ rootNode: undefined, selectedNode: undefined });
        } else {
            const rootNode = JSON.parse(ctx.value.viewContent) as BaseNode;
            this.setState({ rootNode, selectedNode: this.getZeroNode().createChild(rootNode) });
        }

        if (ctx.value.entityType)
            void Navigator.getViewDispatcher().getViewOverrides(ctx.value.entityType.cleanName)
                .then(vos => this.setState({ viewOverrides: vos }));
        else
            this.setState({ viewOverrides: undefined });

        ctx.frame?.frameComponent.forceUpdate();
    }

    getZeroNode(): DesignerNode<BaseNode> {

        const { ctx, ...extraProps } = this.props;

        const context: DesignerContext = {
            refreshView: () => this.updateStateSelectedNode(this.state.selectedNode!.reCreateNode()),
            getSelectedNode: () => this.state.selectedNode,
            setSelectedNode: newNode => this.updateStateSelectedNode(newNode),
            onClose: () => { /* the entity editor has no designer to close */ },
            props: extraProps as Record<string, unknown>,
            propTypes: Object.fromEntries((ctx.value.props ?? []).map(a => [a.name, a.type])),
            locals: {},
            localsCode: ctx.value.locals,
        };

        return DesignerNode.zero(context, ctx.value.entityType.cleanName);
    }

    handleTypeChange = (): void => {

        const dve = this.props.ctx.value;

        this.setState({ exampleEntity: null });

        if (dve.entityType == null) {
            dve.viewContent = null!;
        } else {
            const ctor = resolveType(dve.entityType.cleanName);
            if (ctor == undefined)
                throw new Error(`Type '${dve.entityType.cleanName}' is not registered on the client`);

            dve.viewContent = JSON.stringify(NodeConstructor.createDefaultNode(getTypeInfo(ctor as never)));
        }

        this.updateRoot();
    };

    handleTypeRemove = (): Promise<boolean> => {
        if (this.props.ctx.value.isDirty() || this.props.ctx.value.viewContent !== JSON.stringify(this.state.rootNode!))
            return MessageModal.show({
                title: SaveChangesMessage.ThereAreChanges.niceToString(),
                message: JavascriptMessage.loseCurrentChanges.niceToString(),
                buttons: "yes_no",
                icon: "warning",
                style: "warning",
            }).then(result => result === "yes");

        return Promise.resolve(true);
    };

    override render(): React.JSX.Element {
        const ctx = this.props.ctx;

        return (
            <div>
                <AutoLine ctx={ctx.subCtx(dv => dv.viewName)} />
                <EntityLine ctx={ctx.subCtx(dv => dv.entityType)} onChange={this.handleTypeChange} onRemove={this.handleTypeRemove} />

                {this.state.rootNode && this.renderDesigner()}
            </div>
        );
    }

    renderDesigner(): React.JSX.Element {
        const root = this.getZeroNode().createChild(this.state.rootNode!);
        const ctx = this.props.ctx;

        const exampleCtx = new TypeContext<Entity | null>(
            undefined, { frame: ctx.frame }, root.route!, Binding.create(this.state, s => s.exampleEntity));

        return (
            <div className="design-main" style={{ marginTop: "10px" }}>
                <div className="design-left open">
                    <div className="code-container">
                        <EntityLine ctx={exampleCtx as never} create={true} find={true} remove={true}
                            viewOnCreate={false} view={false} onChange={() => this.forceUpdate()}
                            formGroupStyle="Basic" label={DynamicViewMessage.ExampleEntity.niceToString()} />
                        <DynamicViewTabs ctx={ctx} rootNode={root} />
                    </div>
                </div>
                <div className="design-content open">
                    {this.state.exampleEntity && this.state.viewOverrides &&
                        <RenderWithViewOverrides dn={root} parentCtx={exampleCtx as TypeContext<BaseEntity>}
                            vos={this.state.viewOverrides.filter(a => a.viewName == ctx.value.viewName)} />}
                </div>
            </div>
        );
    }
}
