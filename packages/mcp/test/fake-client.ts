import type { Subprocess } from "bun";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal MCP client for tests: spawns the stdio server and speaks
 * newline-delimited JSON-RPC, exactly like Claude Code and Codex do.
 */
export class FakeMcpClient {
  private readonly process: Subprocess<"pipe", "pipe", "inherit">;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor(serverPath: string, options: { cwd: string; env?: Record<string, string> }) {
    this.process = Bun.spawn(["bun", serverPath], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    for await (const chunk of this.process.stdout) {
      this.buffer += this.decoder.decode(chunk);
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === "number") {
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        }
      }
    }
  }

  private send(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  async request(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request timed out: ${method}`)),
        timeoutMs,
      );
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    const message = await response;
    if (message.error) {
      throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
    }
    return message.result;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fake-client", version: "0.0.1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const result = (await this.request("tools/list")) as {
      tools: Array<{ name: string; description: string }>;
    };
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return {
      text: result.content.map((item) => item.text ?? "").join("\n"),
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    this.process.kill();
    await this.process.exited;
  }
}
