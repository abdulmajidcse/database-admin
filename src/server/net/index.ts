/**
 * The access layer (PLAN §8). Everything else in `src/server` should import
 * from here: `accessResolver.resolve(config, secrets)` returns an address the
 * connector can dial, and nothing about how it got there (§8.1).
 */

export { AccessResolver, accessResolver, accessAdvice } from './access';
export type { AccessStat, ResolveOptions } from './access';

export { allocatePort, releasePort, probeTcp, waitForPort } from './ports';

export {
  SshTunnel,
  openSshTunnel,
  execRemote,
  remoteWhich,
  shellQuote,
  resolveHops,
  hopChainKey,
  lookupSshConfig,
  resolveAgentSocket,
} from './ssh';
export type { ResolvedHop, RemoteExec, RemoteExit, RemoteExecOptions, SshConfigEntry, SshTunnelOptions, TunnelEvent } from './ssh';

export { ProxyProcess } from './proxy';
export type { ProxyEvent, ProxyProcessOptions } from './proxy';
