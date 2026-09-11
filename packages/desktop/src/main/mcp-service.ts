import { McpRuntime, type McpRuntimeSnapshot, parseMcpServerConfigs } from "@dreamcode/mcp";
import { getDreamCodeHome, loadDreamCodeConfig, setMcpServerEnabled } from "@dreamcode/store";
import type { ToolRegistry } from "@dreamcode/tools";

export class DesktopMcpService {
  readonly runtime: McpRuntime;
  readonly home: string;

  constructor(options: { registry: ToolRegistry; home?: string }) {
    this.home = options.home ?? getDreamCodeHome();
    this.runtime = new McpRuntime({ registry: options.registry });
  }

  async initialize(): Promise<McpRuntimeSnapshot> {
    const config = await loadDreamCodeConfig(this.home);
    return this.runtime.reconcile(parseMcpServerConfigs(config.mcpServers));
  }

  async list(): Promise<McpRuntimeSnapshot> {
    return this.runtime.current();
  }

  async refresh(): Promise<McpRuntimeSnapshot> {
    const config = await loadDreamCodeConfig(this.home);
    return this.runtime.reconcile(parseMcpServerConfigs(config.mcpServers), { force: true });
  }

  async setEnabled(request: { serverId: string; enabled: boolean }): Promise<McpRuntimeSnapshot> {
    const config = await setMcpServerEnabled(request.serverId, request.enabled, this.home);
    await this.runtime.reconcile(parseMcpServerConfigs(config.mcpServers));
    return this.runtime.current();
  }

  subscribe(listener: (snapshot: McpRuntimeSnapshot) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}
