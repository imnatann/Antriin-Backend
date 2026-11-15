import { Injectable } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';

/**
 * Port for DNS TXT lookups.
 *
 * Domain ownership can only be proven by reading a record the domain owner
 * published, which means a network call. Keeping it behind an interface lets the
 * service stay testable without pretending a lookup happened: the default
 * implementation really queries DNS, and tests inject a stub resolver.
 */
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

export interface DnsResolver {
  /** Returns one array of strings per TXT record set (records are returned split). */
  resolveTxt(name: string): Promise<string[][]>;
}

@Injectable()
export class NodeDnsResolver implements DnsResolver {
  resolveTxt(name: string): Promise<string[][]> {
    return resolveTxt(name);
  }
}

/** DNS lookups can hang; a stalled resolver must not stall an HTTP request. */
export const DNS_LOOKUP_TIMEOUT_MS = 5000;

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
