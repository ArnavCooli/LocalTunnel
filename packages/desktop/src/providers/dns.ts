/**
 * DNS provider guides.
 *
 * Every one of these ends in the same record. The differences are only where the
 * button is, plus one important caveat for Cloudflare.
 */

export interface DnsGuide {
  id: string;
  name: string;
  url: string;
  steps: string[];
  /** Shown as a prominent warning rather than an ordinary step. */
  warning?: string;
}

export const DNS_GUIDES: DnsGuide[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://dash.cloudflare.com/',
    warning:
      'Set the record to "DNS only" — click the orange cloud so it turns grey. Cloudflare is fine as a DNS provider, but its proxy must not sit in front of LocalTunnel: your gateway terminates TLS itself on your own server, and proxying breaks certificate issuance and non-HTTP services.',
    steps: [
      'Open your domain in the Cloudflare dashboard.',
      'Go to DNS → Records → Add record.',
      'Type: A.',
      'Name: the subdomain only (e.g. "mysite"), or "@" for the bare domain.',
      'IPv4 address: your gateway IP.',
      'Proxy status: click the orange cloud so it reads DNS only (grey).',
      'TTL: Auto. Save.',
    ],
  },
  {
    id: 'namecheap',
    name: 'Namecheap',
    url: 'https://ap.www.namecheap.com/domains/list/',
    steps: [
      'Domain List → Manage next to your domain.',
      'Open the Advanced DNS tab.',
      'Add New Record → A Record.',
      'Host: the subdomain (e.g. "mysite"), or "@" for the bare domain.',
      'Value: your gateway IP.',
      'TTL: Automatic. Save with the green tick.',
    ],
  },
  {
    id: 'godaddy',
    name: 'GoDaddy',
    url: 'https://dcc.godaddy.com/manage/',
    steps: [
      'My Products → DNS next to your domain.',
      'Press Add New Record.',
      'Type: A.',
      'Name: the subdomain (e.g. "mysite"), or "@" for the bare domain.',
      'Value: your gateway IP.',
      'TTL: 1 hour (or 600 seconds if offered). Save.',
    ],
  },
  {
    id: 'porkbun',
    name: 'Porkbun',
    url: 'https://porkbun.com/account/domainsSpeedy',
    steps: [
      'Find your domain and click DNS.',
      'Type: A - Address record.',
      'Host: the subdomain, or leave blank for the bare domain.',
      'Answer: your gateway IP.',
      'TTL: 600. Add.',
    ],
  },
  {
    id: 'squarespace',
    name: 'Squarespace (formerly Google Domains)',
    url: 'https://account.squarespace.com/domains',
    steps: [
      'Open the domain → DNS → DNS Settings.',
      'Under Custom Records, press Add Record.',
      'Type: A.',
      'Host: the subdomain, or "@" for the bare domain.',
      'Data: your gateway IP.',
      'Save.',
    ],
  },
  {
    id: 'route53',
    name: 'AWS Route 53',
    url: 'https://console.aws.amazon.com/route53/v2/hostedzones',
    steps: [
      'Open the hosted zone for your domain.',
      'Create record.',
      'Record name: the subdomain (e.g. "mysite").',
      'Record type: A.',
      'Value: your gateway IP.',
      'TTL: 300. Create records.',
    ],
  },
  {
    id: 'generic',
    name: 'Another provider',
    url: '',
    steps: [
      'Find the DNS or "nameserver records" section of your registrar.',
      'Add a record of type A.',
      'Set its name/host to the subdomain you want (or @ for the bare domain).',
      'Set its value/target to your gateway IP address.',
      'Set the TTL as low as it allows, so changes take effect quickly.',
      'Save, then press "Check DNS" here.',
    ],
  },
];

export function dnsRecordFor(hostname: string, gatewayIp: string): {
  type: 'A';
  name: string;
  value: string;
  ttl: number;
} {
  const parts = hostname.split('.');
  // Two labels means a bare domain (example.com); more means a subdomain.
  const name = parts.length <= 2 ? '@' : parts.slice(0, parts.length - 2).join('.');
  return { type: 'A', name, value: gatewayIp, ttl: 300 };
}
