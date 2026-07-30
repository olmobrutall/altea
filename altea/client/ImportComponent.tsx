// Ported from Signum.React/ImportComponent.tsx — copy-paste + fix. Lazily imports a module (its
// `default` export must be a React component) and renders it once resolved. Used by Navigator's
// `/view` `/create` routes and Finder's `/find` route to code-split the FramePage/SearchPage.
import * as React from 'react'

interface ImportComponentProps {
  onImport: () => Promise<{ default: React.ComponentType<any> }>;
  onError?: (error: any) => React.ReactElement | null;
  componentProps?: {};
}

interface ImportComponentState {
  component?: React.ComponentType<any>;
  error?: any;
}

export class ImportComponent extends React.Component<ImportComponentProps, ImportComponentState> {

  constructor(props: ImportComponentProps) {
    super(props);
    this.state = { component: undefined };
  }

  mounted = false;

  componentDidMount(): void {
    this.mounted = true;
    this.props.onImport()
      .then(module => {
        if (this.mounted)
          this.setState({ component: module.default });
      })
      .catch(error => {
        if (this.mounted)
          this.setState({ error });
      });
  }

  componentWillUnmount(): void {
    this.mounted = false;
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined)
      return this.props.onError ? this.props.onError(this.state.error) : null;

    if (!this.state.component)
      return null;

    return React.createElement(this.state.component, this.props.componentProps);
  }
}

export default ImportComponent;
