#!/usr/bin/env bun
import type { LineageCommand } from "@lineage/contracts";
import { historyCommands } from "@lineage/commands-history";
import { networkCommands } from "@lineage/commands-network";

const commands = new Map<string, LineageCommand>(
  [...historyCommands, ...networkCommands].map((command) => [command.name, command]),
);

const rawArgs = process.argv.slice(2);
const jsonIndex = rawArgs.indexOf("--json");
const json = jsonIndex >= 0;
if (json) rawArgs.splice(jsonIndex, 1);
const commandName = rawArgs.shift();

if (!commandName || commandName === "help" || commandName === "--help") {
  console.log("Lineage: Git-native decision history for coding agents\n");
  for (const command of commands.values()) {
    console.log(`  ${command.name.padEnd(14)} ${command.description}`);
  }
  process.exit(0);
}

const command = commands.get(commandName);
if (!command) {
  console.error(`Unknown command: ${commandName}`);
  process.exit(1);
}

try {
  const result = await command.run(rawArgs, { cwd: process.cwd(), json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`lineage: ${message}`);
  }
  process.exit(1);
}

function printHuman(value: unknown): void {
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}
