/**
 * MCP (Model Context Protocol) Service
 * Manages the MCP server that exposes Git context to external tools
 */

import { invokeCommand } from './tauri-api.ts';
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
