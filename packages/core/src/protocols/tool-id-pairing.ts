export interface ToolIdPairer {
  nextForCall(explicitId: string | undefined, ref: { id?: string }): string;
  resolveForResult(explicitId: string | undefined): string | undefined;
  reset(): void;
}

export function createToolIdPairer(): ToolIdPairer {
  const awaiting: Array<{ ref: { id?: string }; auto: boolean }> = [];
  const seenExplicit = new Set<string>();
  let autoIndex = 0;

  return {
    nextForCall(explicitId, ref) {
      const explicit = explicitId !== undefined && explicitId !== '' ? explicitId : undefined;
      if (explicit !== undefined) {
        seenExplicit.add(explicit);
        ref.id = explicit;
        awaiting.push({ ref, auto: false });
        return explicit;
      }
      let id = `call_${autoIndex}`;
      autoIndex += 1;
      while (seenExplicit.has(id)) {
        id = `call_${autoIndex}`;
        autoIndex += 1;
      }
      ref.id = id;
      awaiting.push({ ref, auto: true });
      return id;
    },
    resolveForResult(explicitId) {
      const explicit = explicitId !== undefined && explicitId !== '' ? explicitId : undefined;
      if (explicit === undefined) {
        return awaiting.shift()?.ref.id;
      }
      seenExplicit.add(explicit);
      const matched = awaiting.findIndex((a) => a.ref.id === explicit);
      if (matched >= 0) {
        awaiting.splice(matched, 1);
      } else {
        const first = awaiting[0];
        if (first?.auto) {
          first.ref.id = explicit;
          awaiting.shift();
        }
      }
      return explicit;
    },
    reset() {
      awaiting.length = 0;
    },
  };
}
