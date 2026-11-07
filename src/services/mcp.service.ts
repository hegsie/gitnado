/**
 * MCP (Model Context Protocol) Service
 * Manages the MCP server that exposes Git context to external tools
 */

import { invokeCommand } from './tauri-api.ts';
import { checkOutboundHostAllowed, isNetworkPolicyActive } from './git.service.ts';
import { settingsStore } from '../stores/settings.store.ts';
import type { CommandResult } from '../types/api.types.ts';

/**
 * MCP server configuration
 */
export interface McpConfig {
  enabled: boolean;
  port: number;
  allowedOrigins: string[];
  /**
   * Bearer token every MCP request must present.
   * Owned by the backend: it is returned by `getMcpConfig` and changed only by
   * `regenerateMcpToken`, never by saving a configuration.
   */
  authToken?: string;
}

/**
 * MCP server status
 */
export interface McpStatus {
  running: boolean;
  port: number;
  url: string | null;
  /** Why the server is not running, when the last start attempt failed */
  lastError: string | null;
}

/**
 * Start the MCP server
 */
export async function startMcpServer(): Promise<CommandResult<void>> {
  return invokeCommand<void>('start_mcp_server');
}

/**
 * Stop the MCP server
 */
export async function stopMcpServer(): Promise<CommandResult<void>> {
  return invokeCommand<void>('stop_mcp_server');
}

/**
 * Get the current MCP server status
 */
export async function getMcpStatus(): Promise<CommandResult<McpStatus>> {
  return invokeCommand<McpStatus>('get_mcp_status');
}

/**
 * Get MCP server configuration
 */
export async function getMcpConfig(): Promise<CommandResult<McpConfig>> {
  return invokeCommand<McpConfig>('get_mcp_config');
}

/**
 * Update MCP server configuration
 *
 * The access token is deliberately not sent: the backend keeps the stored one,
 * so a save can never leak or clear the secret.
 */
export async function setMcpConfig(config: McpConfig): Promise<CommandResult<void>> {
  const { enabled, port, allowedOrigins } = config;
  return invokeCommand<void>('set_mcp_config', { config: { enabled, port, allowedOrigins } });
}

/**
 * Generate a new MCP access token, invalidating the previous one.
 * Returns the new token.
 */
export async function regenerateMcpToken(): Promise<CommandResult<string>> {
  return invokeCommand<string>('regenerate_mcp_token');
}

/**
 * A standing permission for an MCP write tool: `tool` may run without asking
 * in `repoPath` when the affected branch matches `branchPattern` (`*`, `?`).
 */
export interface McpWritePolicy {
  repoPath: string;
  tool: string;
  branchPattern: string;
}

/** MCP write tools: off by default; every write asks unless a policy allows it. */
export interface McpWriteSettings {
  enabled: boolean;
  policies: McpWritePolicy[];
}

/** A write an agent is waiting for the user to approve (`mcp-consent-request`). */
export interface McpConsentRequest {
  id: number;
  tool: string;
  repoPath: string;
  branch: string | null;
  summary: string;
  details: string[];
  /** Unix seconds. */
  requestedAt: number;
  timeoutSecs: number;
}

/** Payload of `mcp-consent-resolved`. */
export interface McpConsentResolved {
  id: number;
  approved: boolean;
  expired?: boolean;
}

/** Payload of `mcp-write-applied`. */
export interface McpWriteApplied {
  tool: string;
  repoPath: string;
  summary: string;
  byPolicy: boolean;
}

export async function getMcpWriteSettings(): Promise<CommandResult<McpWriteSettings>> {
  return invokeCommand<McpWriteSettings>('get_mcp_write_settings');
}

export async function setMcpWriteSettings(settings: McpWriteSettings): Promise<CommandResult<void>> {
  return invokeCommand<void>('set_mcp_write_settings', { settings });
}

export async function getPendingMcpConsents(): Promise<CommandResult<McpConsentRequest[]>> {
  return invokeCommand<McpConsentRequest[]>('get_pending_mcp_consents');
}

export async function respondMcpConsent(
  id: number,
  approve: boolean,
  alwaysAllowPattern?: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>('respond_mcp_consent', { id, approve, alwaysAllowPattern });
}

/** A named MCP client token (the token itself is only ever shown once). */
export interface McpClientInfo {
  id: string;
  name: string;
  /** Unix seconds. */
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreatedMcpClient {
  client: McpClientInfo;
  token: string;
}

/** `gitnado --mcp-stdio`: how to launch the stdio bridge. */
export interface McpStdioCommand {
  program: string;
  args: string[];
}

export async function listMcpClients(): Promise<CommandResult<McpClientInfo[]>> {
  return invokeCommand<McpClientInfo[]>('list_mcp_clients');
}

export async function createMcpClient(name: string): Promise<CommandResult<CreatedMcpClient>> {
  return invokeCommand<CreatedMcpClient>('create_mcp_client', { name });
}

export async function revokeMcpClient(id: string): Promise<CommandResult<void>> {
  return invokeCommand<void>('revoke_mcp_client', { id });
}

export async function getMcpStdioCommand(): Promise<CommandResult<McpStdioCommand>> {
  return invokeCommand<McpStdioCommand>('get_mcp_stdio_command');
}

/** How Gitnado reaches an external MCP server (MCP client mode, #613). */
export type ExternalMcpTransport =
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args: string[] };

/** An MCP server Gitnado's AI features may call for context. */
export interface ExternalMcpServer {
  /** Empty for a server not saved yet. */
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  enabled: boolean;
  /** Tool to call for AI context; null when the server is not a context source. */
  contextTool: string | null;
  /** JSON arguments with {branch} {issueKey} {issueNumber} {repo} placeholders. */
  contextArgs: string | null;
  /** A bearer token is stored in the system keyring. */
  hasToken: boolean;
}

export interface ExternalMcpTool {
  name: string;
  description: string;
}

export interface ExternalMcpContext {
  server: string;
  text: string;
}

export async function listExternalMcpServers(): Promise<CommandResult<ExternalMcpServer[]>> {
  return invokeCommand<ExternalMcpServer[]>('list_external_mcp_servers');
}

export async function saveExternalMcpServer(
  server: ExternalMcpServer,
  token?: string,
  clearToken?: boolean,
): Promise<CommandResult<ExternalMcpServer>> {
  return invokeCommand<ExternalMcpServer>('save_external_mcp_server', { server, token, clearToken });
}

export async function removeExternalMcpServer(id: string): Promise<CommandResult<void>> {
  return invokeCommand<void>('remove_external_mcp_server', { id });
}

/**
 * The security gate for contacting an external MCP server.
 *
 * An HTTP server is judged by its host, exactly like the AI providers. A stdio
 * server is a local process, but it may reach the network on its own, so
 * offline mode refuses it too. The backend applies the same rules.
 */
async function gateExternalServer<T>(
  server: ExternalMcpServer | undefined,
): Promise<CommandResult<T> | null> {
  if (!isNetworkPolicyActive()) return null;
  const transport = server?.transport;
  if (transport?.type === 'stdio') {
    if (!settingsStore.getState().offlineMode) return null;
    return {
      success: false,
      error: {
        code: 'BLOCKED',
        message: 'Offline mode is on: external MCP servers are not contacted.',
      },
    };
  }
  let host: string | null = null;
  try {
    host = transport?.type === 'http' ? new URL(transport.url).hostname : null;
  } catch {
    host = null;
  }
  const reason = await checkOutboundHostAllowed(host);
  if (!reason) return null;
  return {
    success: false,
    error: {
      code: 'BLOCKED',
      message:
        reason === 'offline'
          ? 'Offline mode is on: external MCP servers are not contacted.'
          : `${host ?? 'This server'} is not in your remote allowlist. Add it in Settings > Security.`,
    },
  };
}

/** Connect to a saved server and list its tools. */
export async function listExternalMcpTools(
  server: ExternalMcpServer,
): Promise<CommandResult<ExternalMcpTool[]>> {
  const blocked = await gateExternalServer<ExternalMcpTool[]>(server);
  if (blocked) return blocked;
  return invokeCommand<ExternalMcpTool[]>('list_external_mcp_tools', { id: server.id });
}

/** What a saved server would add to an AI prompt for this repository. */
export async function previewExternalMcpContext(
  server: ExternalMcpServer,
  repoPath: string,
): Promise<CommandResult<ExternalMcpContext | null>> {
  const blocked = await gateExternalServer<ExternalMcpContext | null>(server);
  if (blocked) return blocked;
  return invokeCommand<ExternalMcpContext | null>('preview_external_mcp_context', {
    id: server.id,
    repoPath,
  });
}
