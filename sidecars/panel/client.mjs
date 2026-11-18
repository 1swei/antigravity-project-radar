import { readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { platformPaths } from '../../compat/platform.mjs';
import { discoverProcesses, httpLogPorts } from './discovery.mjs';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';

function serverFromPorts(logPorts, processes) {
  const rows = (Array.isArray(processes) ? processes : [processes]).filter(p => /--standalone\b/.test(p.CommandLine || ''));
  if (rows.length !== 1) throw new Error(rows.length ? 'Multiple Antigravity instances detected' : 'Antigravity desktop service not found');
  const ports = new Set([rows[0].Ports].flat().map(Number));
  const port = logPorts.find(p => ports.has(p));
  if (!port) throw new Error('Waiting for Antigravity local API');
  const csrf = rows[0].CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!csrf) throw new Error('Missing local API credentials');
  return { port, csrf, pid: rows[0].ProcessId };
}

export class AntigravityClient {
  constructor({ paths = platformPaths, readLog = readFile, logStat = stat, processes = discoverProcesses, now = Date.now } = {}) {
    this.paths = paths;
    this.readLog = readLog;
    this.logStat = logStat;
    this.processes = processes;
    this.now = now;
  }

  server = null;
  discoveredAt = 0;
  discovering = null;
  lastScanAt = -Infinity;
  retryAt = 0;
  discoveryFailures = 0;
  discoveryError = null;

  async discover(force = false) {
    if (!force && this.server && this.now() - this.discoveredAt < 15000) return this.server;
    if (this.discovering) return this.discovering;
    if (!force && this.discoveryError && this.now() < this.retryAt) throw this.discoveryError;
    this.lastScanAt = this.now();
    this.discovering = this.discoverNow()
      .then(server => {
        this.discoveredAt = this.now();
        this.discoveryFailures = 0;
        this.discoveryError = null;
        this.retryAt = 0;
        return server;
      })
      .catch(error => {
        this.discoveryError = error;
        this.discoveryFailures++;
        this.retryAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(4, this.discoveryFailures - 1));
        throw error;
      })
      .finally(() => { this.discovering = null; });
    return this.discovering;
  }

  async discoverNow() {
    this.server = null;
    const paths = this.paths();
    const logs = [];
    const files = [...new Set(paths.logCandidates || [paths.log])];
    for (const file of files) {
      try {
        let modifiedAt = null;
        if (files.length > 1) {
          try {
            const info = await this.logStat(file);
            if (Number.isFinite(info?.mtimeMs)) modifiedAt = info.mtimeMs;
          } catch {}
        }
        logs.push({ ports: httpLogPorts(await this.readLog(file, 'utf8')), modifiedAt });
      } catch (error) {
        logs.push({ error });
      }
    }
    if (logs.every(entry => entry.error || Number.isFinite(entry.modifiedAt))) {
      logs.sort((a, b) => {
        const first = a.modifiedAt ?? -Infinity;
        const second = b.modifiedAt ?? -Infinity;
        return first === second ? 0 : second - first;
      });
    }
    const expectedPorts = [...new Set(logs.flatMap(log => log.ports || []))];
    const parsed = await this.processes({ expectedPorts });
    if (!parsed || (Array.isArray(parsed) && !parsed.length)) throw new Error('Open Antigravity first');

    let foundLog = false;
    let lastError = null;
    for (const entry of logs) {
      try {
        if (entry.error) throw entry.error;
        foundLog = true;
        this.server = serverFromPorts(entry.ports, parsed);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') lastError = error;
      }
    }
    if (!this.server) throw lastError || new Error(foundLog ? 'Waiting for Antigravity local API' : 'Language server log not found');
    this.discoveredAt = this.now();
    return this.server;
  }

  async call(method, body = {}, retry = true) {
    const server = await this.discover();
    try {
      return await new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = request({
          hostname: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: SERVICE + method,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': server.csrf,
            'Content-Length': Buffer.byteLength(data),
          },
        }, res => {
          let text = '';
          let bytes = 0;
          let failed = false;
          const fail = error => {
            if (failed) return;
            failed = true;
            reject(error);
            req.destroy(error);
          };
          res.setEncoding('utf8');
          res.on('error', error => { if (!failed) reject(error); });
          res.on('data', chunk => {
            if (failed) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 32 * 1024 * 1024) { fail(new Error('API response exceeded size limit')); return; }
            text += chunk;
          });
          res.on('end', () => {
            if (failed) return;
            if (res.statusCode !== 200) return reject(Object.assign(new Error(`Antigravity ${method} returned ${res.statusCode}`), { status: res.statusCode }));
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error('Invalid JSON response from Antigravity API'));
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('Antigravity local API timeout')));
        const deadline = setTimeout(() => req.destroy(new Error('Antigravity local API timeout')), 20000);
        deadline.unref?.();
        req.once('close', () => clearTimeout(deadline));
        req.end(data);
      });
    } catch (error) {
      const endpointLost = [401, 403].includes(error.status) || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(error.code);
      if (!endpointLost) throw error;
      if (this.server === server) {
        this.server = null;
        this.discoveryError = error;
        this.retryAt = Math.max(this.retryAt, this.lastScanAt + 3000);
      }
      if (retry) {
        await this.discover();
        return this.call(method, body, false);
      }
      throw error;
    }
  }
}
