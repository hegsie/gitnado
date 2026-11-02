import { expect } from '@open-wc/testing';
import {
  allSnippets,
  claudeCodeSnippet,
  cursorSnippet,
  mcpUrl,
  stdioSnippet,
  vscodeSnippet,
} from '../mcp-snippets.ts';

describe('mcp-snippets', () => {
  const token = 'gnc_abc123';

  it('points every client at the local /mcp endpoint', () => {
    expect(mcpUrl(3001)).to.equal('http://127.0.0.1:3001/mcp');
  });

  it('builds the Claude Code command with a quoted header', () => {
    expect(claudeCodeSnippet(4000, token)).to.equal(
      "claude mcp add --transport http gitnado http://127.0.0.1:4000/mcp --header 'Authorization: Bearer gnc_abc123'",
    );
    expect(claudeCodeSnippet(1, "it's")).to.contain(`'Authorization: Bearer it'\\''s'`);
  });

  it('builds Cursor and VS Code JSON with the bearer header', () => {
    const cursor = JSON.parse(cursorSnippet(3001, token));
    expect(cursor.mcpServers.gitnado).to.deep.equal({
      url: 'http://127.0.0.1:3001/mcp',
      headers: { Authorization: 'Bearer gnc_abc123' },
    });
    const vscode = JSON.parse(vscodeSnippet(3001, token));
    expect(vscode.servers.gitnado).to.deep.equal({
      type: 'http',
      url: 'http://127.0.0.1:3001/mcp',
      headers: { Authorization: 'Bearer gnc_abc123' },
    });
  });

  it('builds a stdio launcher passing the token through the environment', () => {
    const stdio = JSON.parse(stdioSnippet(3001, token, '/Applications/Gitnado.app/Contents/MacOS/gitnado', ['--mcp-stdio']));
    expect(stdio.mcpServers.gitnado).to.deep.equal({
      command: '/Applications/Gitnado.app/Contents/MacOS/gitnado',
      args: ['--mcp-stdio'],
      env: { GITNADO_MCP_TOKEN: 'gnc_abc123', GITNADO_MCP_URL: 'http://127.0.0.1:3001/mcp' },
    });
  });

  it('offers stdio only when the launcher is known', () => {
    expect(allSnippets(3001, token, null).map((s) => s.kind)).to.deep.equal(['claude-code', 'cursor', 'vscode']);
    expect(allSnippets(3001, token, { program: 'g', args: ['--mcp-stdio'] }).map((s) => s.kind)).to.include('stdio');
  });
});
