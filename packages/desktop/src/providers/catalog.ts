/**
 * Providers other than Oracle Cloud.
 *
 * These get a short, honest walkthrough rather than Oracle's twelve steps: they are
 * all a variation on "make an Ubuntu VM, allow 80 and 443, note the IP". The gateway
 * installation afterwards is identical everywhere.
 */

export interface ProviderGuide {
  id: string;
  name: string;
  /** Shown on the provider card. */
  tagline: string;
  recommended: boolean;
  consoleUrl: string;
  /** Typical monthly cost of a suitable machine, for the card. */
  cost: string;
  /** The SSH username the provider's default image uses. */
  defaultUser: string;
  steps: string[];
  /** How this provider's own firewall works — the part people get wrong. */
  firewallNote: string;
  /** True when a provider API integration exists for one-click provisioning. */
  apiSupported: boolean;
}

export const PROVIDERS: ProviderGuide[] = [
  {
    id: 'oracle',
    name: 'Oracle Cloud',
    tagline: 'Free forever, best value — full guided setup',
    recommended: true,
    consoleUrl: 'https://cloud.oracle.com/',
    cost: 'Free',
    defaultUser: 'ubuntu',
    apiSupported: false,
    firewallNote:
      'Oracle blocks all inbound traffic except SSH by default, in the VCN security list. You must add ingress rules for TCP 443 and TCP 80 yourself — LocalTunnel cannot do it from inside the server.',
    steps: ['Use the dedicated Oracle Cloud wizard for a full walkthrough.'],
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    tagline: 'Simplest paid option',
    recommended: false,
    consoleUrl: 'https://cloud.digitalocean.com/droplets/new',
    cost: 'from $4/mo',
    defaultUser: 'root',
    apiSupported: false,
    firewallNote:
      'New Droplets accept all inbound traffic unless you attach a Cloud Firewall. If you attach one, allow TCP 22, 80 and 443.',
    steps: [
      'Create a Droplet.',
      'Choose Ubuntu 22.04 LTS.',
      'Pick the cheapest Basic / Regular plan — a gateway needs very little.',
      'Choose a datacentre region near your visitors.',
      'Under Authentication choose SSH Key and add yours (or create one).',
      'Create the Droplet and copy its public IPv4 address.',
      'Come back here and install the gateway. The username is "root".',
    ],
  },
  {
    id: 'vultr',
    name: 'Vultr',
    tagline: 'Wide choice of regions',
    recommended: false,
    consoleUrl: 'https://my.vultr.com/deploy/',
    cost: 'from $5/mo',
    defaultUser: 'root',
    apiSupported: false,
    firewallNote:
      'Vultr instances are open by default. If you use a Vultr Firewall Group, allow TCP 22, 80 and 443.',
    steps: [
      'Deploy a new Cloud Compute instance.',
      'Choose Ubuntu 22.04 x64.',
      'Pick the smallest Regular Performance plan.',
      'Add your SSH key under "SSH Keys".',
      'Deploy, wait for the status to become Running, and copy the IP address.',
      'Install the gateway here with the username "root".',
    ],
  },
  {
    id: 'hetzner',
    name: 'Hetzner',
    tagline: 'Cheapest for the specs',
    recommended: false,
    consoleUrl: 'https://console.hetzner.cloud/',
    cost: 'from €3.79/mo',
    defaultUser: 'root',
    apiSupported: false,
    firewallNote:
      'Hetzner Cloud servers are open by default. If you attach a firewall, allow TCP 22, 80 and 443 inbound.',
    steps: [
      'Create a project, then Add Server.',
      'Choose Ubuntu 22.04 and the CX22 (or smallest available) shared vCPU plan.',
      'Add your SSH key.',
      'Create the server and copy the IPv4 address.',
      'Install the gateway here with the username "root".',
    ],
  },
  {
    id: 'linode',
    name: 'Linode / Akamai',
    tagline: 'Straightforward and reliable',
    recommended: false,
    consoleUrl: 'https://cloud.linode.com/linodes/create',
    cost: 'from $5/mo',
    defaultUser: 'root',
    apiSupported: false,
    firewallNote:
      'Linodes accept all inbound traffic by default. If you enable Cloud Firewall, allow TCP 22, 80 and 443.',
    steps: [
      'Create a Linode.',
      'Choose Ubuntu 22.04 LTS and a region near your visitors.',
      'Pick the Nanode 1GB shared plan.',
      'Add an SSH key, then create.',
      'Copy the IPv4 address and install the gateway here as "root".',
    ],
  },
  {
    id: 'aws',
    name: 'AWS',
    tagline: 'Free tier for 12 months (EC2 or Lightsail)',
    recommended: false,
    consoleUrl: 'https://console.aws.amazon.com/ec2/home#LaunchInstances:',
    cost: 'Free 12mo, then ~$5/mo',
    defaultUser: 'ubuntu',
    apiSupported: false,
    firewallNote:
      'AWS security groups block everything inbound by default. Edit the instance\'s security group and add inbound rules for TCP 443 and TCP 80 from 0.0.0.0/0, plus TCP 22 for SSH.',
    steps: [
      'EC2 → Launch instance (Lightsail is simpler if you have the choice).',
      'Choose the Ubuntu Server 22.04 LTS AMI.',
      'Instance type t2.micro or t3.micro (free tier eligible).',
      'Create or select a key pair and download the .pem file.',
      'Under Network settings, allow SSH, HTTP and HTTPS.',
      'Launch, then copy the Public IPv4 address.',
      'Install the gateway here with the username "ubuntu".',
    ],
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    tagline: 'Always Free e2-micro in some regions',
    recommended: false,
    consoleUrl: 'https://console.cloud.google.com/compute/instancesAdd',
    cost: 'Free tier available',
    defaultUser: 'your Google username',
    apiSupported: false,
    firewallNote:
      'GCP blocks inbound traffic unless a firewall rule allows it. Tick "Allow HTTP traffic" and "Allow HTTPS traffic" when creating the VM, which creates the rules for you.',
    steps: [
      'Compute Engine → Create instance.',
      'Machine type e2-micro, region us-west1, us-central1 or us-east1 for the free tier.',
      'Boot disk → change to Ubuntu 22.04 LTS.',
      'Tick Allow HTTP traffic and Allow HTTPS traffic.',
      'Under Security → Manage Access, add your SSH public key.',
      'Create, then copy the External IP.',
      'Install the gateway here using the username attached to your SSH key.',
    ],
  },
  {
    id: 'azure',
    name: 'Microsoft Azure',
    tagline: 'Free credit for new accounts',
    recommended: false,
    consoleUrl: 'https://portal.azure.com/#create/Microsoft.VirtualMachine',
    cost: 'Free credit, then ~$4/mo',
    defaultUser: 'azureuser',
    apiSupported: false,
    firewallNote:
      'Azure Network Security Groups block inbound traffic by default. Add inbound port rules for 443 and 80 (TCP, source Any) to the VM\'s NSG.',
    steps: [
      'Create a Virtual machine.',
      'Image: Ubuntu Server 22.04 LTS. Size: B1s.',
      'Authentication type: SSH public key, and download the private key when offered.',
      'Under "Select inbound ports", allow HTTP (80) and HTTPS (443).',
      'Create, then copy the Public IP address.',
      'Install the gateway here with the username you chose (default "azureuser").',
    ],
  },
  {
    id: 'generic',
    name: 'Other VPS',
    tagline: 'Any server you can SSH into',
    recommended: false,
    consoleUrl: '',
    cost: 'varies',
    defaultUser: 'root',
    apiSupported: false,
    firewallNote:
      'Whatever firewall sits in front of the machine must allow inbound TCP 443 and TCP 80. LocalTunnel configures the firewall running on the server itself (ufw, firewalld or nftables) during installation.',
    steps: [
      'Make sure the server runs Ubuntu, Debian, Rocky, Alma or Fedora.',
      'Make sure it has a public IPv4 address.',
      'Make sure you can SSH in with a key, and that the account has sudo.',
      'Allow inbound TCP 443 and 80 in whatever firewall sits in front of it.',
      'Enter the details here and install the gateway.',
    ],
  },
];

export function providerById(id: string): ProviderGuide | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
