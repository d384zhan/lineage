export class CommandArguments {
  private readonly values = new Map<string, string[]>();
  readonly positional: string[] = [];

  constructor(args: readonly string[]) {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (!value) continue;
      if (!value.startsWith("--")) {
        this.positional.push(value);
        continue;
      }
      const [rawKey, inlineValue] = value.slice(2).split("=", 2);
      if (!rawKey) continue;
      const next = inlineValue ?? args[index + 1];
      if (inlineValue === undefined && next && !next.startsWith("--")) index += 1;
      const existing = this.values.get(rawKey) ?? [];
      existing.push(next && !next.startsWith("--") ? next : "true");
      this.values.set(rawKey, existing);
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name)?.at(-1);
  }

  all(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  require(name: string): string {
    const value = this.get(name);
    if (!value || value === "true") throw new Error(`Missing --${name}`);
    return value;
  }
}

export function parseAssumptions(values: readonly string[]) {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Assumption must use key=value: ${value}`);
    }
    return {
      key: value.slice(0, separator),
      value: value.slice(separator + 1),
    };
  });
}
