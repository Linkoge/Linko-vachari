import { spawn, ChildProcess } from 'node:child_process';
import { WorkflowError } from './types';
export class PrivateDisplay {
  child?: ChildProcess;
  name?: string;
  async open() {
    if (this.name) return this.name;
    try {
      this.name = await new Promise<string>((resolve, reject) => {
        const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1360x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
        this.child = child; let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 8000);
        child.stdio[3]!.on('data', chunk => { output += chunk; if (/^\d+\n$/.test(output)) { clearTimeout(timer); resolve(':' + output.trim()); } });
        child.on('error', () => { clearTimeout(timer); reject(new Error('display')); });
        child.on('exit', () => { clearTimeout(timer); this.name = undefined; reject(new Error('closed')); });
      });
      return this.name;
    } catch { throw new WorkflowError('DISPLAY', 'The private browser needs Xvfb on this server. Ask the operator to install it; no shared desktop or public VNC is used.'); }
  }
  close() { this.child?.kill(); this.child = undefined; this.name = undefined; }
}
