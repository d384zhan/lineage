import { z } from "zod";

export const CommandContextSchema = z.object({
  cwd: z.string().min(1),
  json: z.boolean().default(false),
});

export type CommandContext = z.input<typeof CommandContextSchema>;

export interface LineageCommand<TResult = unknown> {
  readonly name: string;
  readonly description: string;
  run(args: readonly string[], context: CommandContext): Promise<TResult>;
}
