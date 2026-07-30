// Builds underscore-joined column names while descending into embedded fields,
// mirroring Signum's NameSequence. The void (root) sequence contributes no
// prefix, so top-level columns keep their bare field name.
//
//   NameSequence.void().add('shippingAddress').add('city').toString()  // "shippingAddress_city"
//   NameSequence.void().add('name').toString()                         // "name"
export class NameSequence {
    private constructor(
        private readonly value: string,
        private readonly pre?: NameSequence,
    ) { }

    static void(): NameSequence {
        return new NameSequence('');
    }

    add(name: string): NameSequence {
        return new NameSequence(name, this);
    }

    toString(): string {
        if (this.pre == null || this.pre.value === '')
            return this.value;
        return `${this.pre.toString()}_${this.value}`;
    }
}
