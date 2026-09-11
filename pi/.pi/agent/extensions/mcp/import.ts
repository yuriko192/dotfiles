import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatImportSummary, writeImportedMcpFile } from "./host-config.ts";
import type { McpImportResult } from "./types.ts";

export { formatImportSummary, listHostSources } from "./host-config.ts";

export function piMcpPath(): string {
	return join(getAgentDir(), "mcp.json");
}

export function importHostMcpConfigs(options: {
	cwd: string;
	projectTrusted: boolean;
	destPath?: string;
}): McpImportResult {
	return writeImportedMcpFile(options.destPath ?? piMcpPath(), options);
}
