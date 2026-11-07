/**
 * Ready-to-paste MCP client configuration (roadmap 4.2, issue #612).
 *
 * Pure functions so the exact text each client needs is unit-tested.
 */

export type McpClientKind = 'claude-code' | 'cursor' | 'vscode' | 'stdio';

export interface McpSnippet {
  kind: McpClientKind;
  label: string;
  /** Where the snippet goes. */
  where: string;
  text: string;
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** POSIX-shell single quoting for the Claude Code command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function claudeCodeSnippet(port: number, token: string): string {
  return `claude mcp add --transport http gitnado ${mcpUrl(port)} --header ${shellQuote(`Authorization: Bearer ${token}`)}`;
}

export function cursorSnippet(port: number, token: string): string {
  return JSON.stringify(
    { mcpServers: { gitnado: { url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

export function vscodeSnippet(port: number, token: string): string {
  return JSON.stringify(
    {
      servers: {
        gitnado: { type: 'http', url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

export function stdioSnippet(port: number, token: string, program: string, args: string[]): string {
  return JSON.stringify(
    {
      mcpServers: {
        gitnado: {
          command: program,
          args,
          env: { GITNADO_MCP_TOKEN: token, GITNADO_MCP_URL: mcpUrl(port) },
        },
      },
    },
    null,
    2,
  );
}

export function allSnippets(
  port: number,
  token: string,
  stdio: { program: string; args: string[] } | null,
): McpSnippet[] {
  const snippets: McpSnippet[] = [
    { kind: 'claude-code', label: 'Claude Code', where: 'Run in a terminal', text: claudeCodeSnippet(port, token) },
    { kind: 'cursor', label: 'Cursor', where: '.cursor/mcp.json', text: cursorSnippet(port, token) },
    { kind: 'vscode', label: 'VS Code', where: '.vscode/mcp.json', text: vscodeSnippet(port, token) },
  ];
  if (stdio) {
    snippets.push({
      kind: 'stdio',
      label: 'Other (stdio)',
      where: "The client's MCP server config",
      text: stdioSnippet(port, token, stdio.program, stdio.args),
    });
  }
  return snippets;
}
