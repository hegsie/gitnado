import { expect } from '@open-wc/testing';
import {
  AGENT_CLIS,
  agentCommandLine,
  branchNameProblem,
  buildTaskPrompt,
  defaultWorktreePath,
  shellKind,
  slugify,
  suggestBranchName,
} from '../agent-task.service.ts';

const claude = AGENT_CLIS.find((a) => a.id === 'claude')!;
const gemini = AGENT_CLIS.find((a) => a.id === 'gemini')!;

describe('agent-task.service', () => {
  it('detects the shell kind from the program path', () => {
    expect(shellKind('/bin/zsh')).to.equal('posix');
    expect(shellKind('/usr/bin/fish')).to.equal('posix');
    expect(shellKind('C:\\Windows\\System32\\cmd.exe')).to.equal('cmd');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).to.equal('powershell');
    expect(shellKind('powershell.exe')).to.equal('powershell');
    expect(shellKind(null)).to.equal('posix');
  });

  it('references the prompt variable instead of embedding the prompt', () => {
    expect(agentCommandLine(claude, 'posix')).to.equal('claude "$GITNADO_TASK_PROMPT"');
    expect(agentCommandLine(claude, 'cmd')).to.equal('claude "%GITNADO_TASK_PROMPT%"');
    expect(agentCommandLine(claude, 'powershell')).to.equal('claude $env:GITNADO_TASK_PROMPT');
    expect(agentCommandLine(gemini, 'posix')).to.equal('gemini -i "$GITNADO_TASK_PROMPT"');
  });

  it('puts the issue at the top of the prompt', () => {
    expect(buildTaskPrompt('  Fix login  ', '')).to.equal('Fix login');
    expect(buildTaskPrompt('Fix login', 'PROJ-12')).to.equal('Issue: PROJ-12\n\nFix login');
  });

  it('slugifies text safely', () => {
    expect(slugify('Fix the Login Bug!!')).to.equal('fix-the-login-bug');
    expect(slugify('Café naïve résumé')).to.equal('cafe-naive-resume');
    expect(slugify('$$$')).to.equal('task');
    expect(slugify('a'.repeat(100)).length).to.be.at.most(40);
  });

  it('suggests agent/ branch names from the issue and task', () => {
    expect(suggestBranchName('Fix the login bug', '')).to.equal('agent/fix-the-login-bug');
    expect(suggestBranchName('Fix the login bug', 'PROJ-123')).to.equal('agent/proj-123-fix-the-login-bug');
    expect(suggestBranchName('Fix it', 'https://github.com/o/r/issues/42')).to.equal('agent/42-fix-it');
    expect(branchNameProblem(suggestBranchName('x'.repeat(200), 'y'.repeat(200)))).to.be.null;
  });

  it('validates branch names like git does', () => {
    expect(branchNameProblem('agent/fix-login')).to.be.null;
    expect(branchNameProblem('')).to.contain('Enter');
    expect(branchNameProblem('has space')).to.not.be.null;
    expect(branchNameProblem('a..b')).to.not.be.null;
    expect(branchNameProblem('-flag')).to.not.be.null;
    expect(branchNameProblem('x.lock')).to.not.be.null;
    expect(branchNameProblem('a/.hidden')).to.not.be.null;
    expect(branchNameProblem('a@{b')).to.not.be.null;
  });

  it('places worktrees next to the repository', () => {
    expect(defaultWorktreePath('/home/u/code/app', 'agent/fix-login')).to.equal(
      '/home/u/code/app.worktrees/fix-login',
    );
    expect(defaultWorktreePath('/home/u/code/app/', 'agent/x')).to.equal('/home/u/code/app.worktrees/x');
    expect(defaultWorktreePath('C:\\code\\app', 'agent/fix')).to.equal('C:\\code\\app.worktrees\\fix');
  });
});
