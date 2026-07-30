// Ported from Signum.React/Lines/TextBase.tsx — copy-paste + fix (import retargeted only).
import * as React from 'react';
import { ValueBaseController, type ValueBaseProps } from './ValueBase'

export interface TextBaseProps<V = any> extends ValueBaseProps<V> {
  autoTrimString?: boolean;
  autoFixString?: boolean;
  triggerChange?: "onBlur";
}

export class TextBaseController<T extends TextBaseProps<V>, V> extends ValueBaseController<T, V> {

  tempValueRef!: React.RefObject<V | null>;
  override init(p: T): void {
    super.init(p);
    this.tempValueRef = React.useRef<V>(null);
  }

  setTempValue(value: V): void {
    (this.tempValueRef as React.RefObject<V>).current = value;
    this.forceUpdate();
  }

  getValue(): V {
    return this.tempValueRef.current ?? this.props.ctx.value;
  }
}
