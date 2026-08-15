/**
 * The Oracle Cloud walkthrough.
 *
 * Oracle's Always Free tier is the best fit for a gateway — a permanently free VM
 * with a public IPv4 — but its console is the least forgiving of the major clouds.
 * So this wizard assumes no prior knowledge: every step says what to click, why it
 * matters, what the screen should look like afterwards, and what to do when it
 * doesn't.
 */

export interface WizardStep {
  id: string;
  title: string;
  /** One-line summary shown in the step list. */
  summary: string;
  /** The actual instructions, in order. */
  instructions: string[];
  /** Answers "why do I need this?" — always shown, collapsed. */
  why: string;
  /** Answers "what should I see?" */
  expect: string;
  /** A link that opens the right Oracle Cloud page in the system browser. */
  link?: { label: string; url: string };
  /** Things that commonly go wrong at this step. */
  troubleshooting: { problem: string; fix: string }[];
  /** Values the user has to bring back into LocalTunnel. */
  collects?: ('publicIp' | 'sshKey' | 'username')[];
  /** Name of the bundled illustration, rendered as a diagram in the UI. */
  illustration?: string;
}

export const ORACLE_STEPS: WizardStep[] = [
  {
    id: 'account',
    title: 'Create an Oracle Cloud account',
    summary: 'Sign up for Oracle Cloud (free tier).',
    why: 'LocalTunnel needs a computer with a public IP address that is always on. Your home connection is behind CGNAT, so it cannot be that computer. Oracle Cloud gives away a small virtual server permanently, which is enough to run your gateway.',
    expect: 'You end up signed in to the Oracle Cloud console, showing a dashboard with a "Launch resources" panel.',
    link: { label: 'Open Oracle Cloud sign-up', url: 'https://signup.cloud.oracle.com/' },
    instructions: [
      'Open the Oracle Cloud sign-up page.',
      'Enter your country and email address, then verify the email.',
      'Fill in your name and address, and choose a password.',
      'Add a credit or debit card. Oracle uses it only to verify your identity — Always Free resources are not charged. A small temporary authorisation may appear and then disappear.',
      'Choose your home region. Pick the one closest to your visitors: this cannot be changed later.',
      'Wait for the account to be provisioned. This usually takes a few minutes, occasionally longer.',
    ],
    troubleshooting: [
      {
        problem: 'The sign-up says my card was declined.',
        fix: 'Virtual and prepaid cards are frequently rejected. A normal debit or credit card usually works. Some banks also block the verification charge — approving it in your banking app and retrying often fixes it.',
      },
      {
        problem: 'My account is stuck "provisioning".',
        fix: 'Oracle sometimes takes several hours to review new accounts. You will get an email when it is ready. Nothing is wrong on your side.',
      },
      {
        problem: 'I would rather not use Oracle.',
        fix: 'Go back and pick another provider. Any VPS with a public IPv4 works — LocalTunnel installs the same gateway on all of them.',
      },
    ],
  },
  {
    id: 'region',
    title: 'Check your region',
    summary: 'Confirm which region your resources will live in.',
    why: 'Every visitor to your site connects to your gateway first, so the physical location of that server sets the baseline latency for everyone.',
    expect: 'The region name appears in the top-right of the console, for example "US East (Ashburn)".',
    link: { label: 'Open the Oracle Cloud console', url: 'https://cloud.oracle.com/' },
    instructions: [
      'Look at the top-right of the console — the region is shown next to your account name.',
      'Note it down. Always Free resources exist only in your home region.',
      'If it is far from where your visitors are, that is not fatal — it just adds latency.',
    ],
    troubleshooting: [
      {
        problem: 'I chose the wrong region at sign-up.',
        fix: 'The home region cannot be changed. If it matters a lot, create a new account with the right region, or use a different provider.',
      },
    ],
  },
  {
    id: 'compute',
    title: 'Open Compute → Instances',
    summary: 'Find the page where virtual machines are created.',
    why: 'An "instance" is Oracle\'s word for a virtual machine. This is the server that will run your LocalTunnel gateway.',
    expect: 'A page titled "Instances" with a blue "Create instance" button. The list is probably empty.',
    link: { label: 'Open Compute → Instances', url: 'https://cloud.oracle.com/compute/instances' },
    instructions: [
      'Open the navigation menu (☰) at the top-left of the console.',
      'Choose Compute, then Instances.',
      'Check the "Compartment" selector on the left is set to your root compartment (it has your account name).',
      'Press Create instance.',
    ],
    troubleshooting: [
      {
        problem: 'I do not see a Compute entry.',
        fix: 'Your account may still be provisioning. Wait for the confirmation email and sign in again.',
      },
    ],
  },
  {
    id: 'image',
    title: 'Choose Ubuntu',
    summary: 'Change the operating system image to Ubuntu 22.04.',
    why: 'LocalTunnel installs and tests against Ubuntu. Oracle Linux is offered by default and works, but Ubuntu is the smoothest path and the one this guide assumes.',
    expect: 'The Image panel shows "Canonical Ubuntu 22.04".',
    instructions: [
      'In the Create instance form, find the "Image and shape" panel.',
      'Press Edit, then Change image.',
      'Select Canonical Ubuntu from the list of images.',
      'Choose the 22.04 build (24.04 also works), then press Select image.',
    ],
    troubleshooting: [
      {
        problem: 'I already created the instance with Oracle Linux.',
        fix: 'That is fine — LocalTunnel supports it. The SSH username will be "opc" rather than "ubuntu".',
      },
    ],
  },
  {
    id: 'shape',
    title: 'Choose a shape',
    summary: 'Pick an Always Free eligible VM size.',
    why: 'The "shape" is how much CPU and memory the server has. A gateway does very little work, so the smallest Always Free shape is plenty — it forwards bytes, it does not run your website.',
    expect: 'The shape panel shows either VM.Standard.A1.Flex (1 OCPU, 6 GB) or VM.Standard.E2.1.Micro, with an "Always Free eligible" badge.',
    instructions: [
      'In the same "Image and shape" panel, press Change shape.',
      'Choose the Ampere series and pick VM.Standard.A1.Flex.',
      'Set 1 OCPU and 6 GB of memory — comfortably inside the free allowance.',
      'If Ampere capacity is unavailable, switch to Specialty and previous generation → VM.Standard.E2.1.Micro instead.',
      'Confirm the "Always Free eligible" label is showing before continuing.',
    ],
    troubleshooting: [
      {
        problem: '"Out of host capacity" when I try to create the instance.',
        fix: 'Ampere shapes are frequently full in popular regions. Either retry later (capacity is released constantly) or use VM.Standard.E2.1.Micro, which is almost always available and is more than enough for a gateway.',
      },
      {
        problem: 'It says the shape is not Always Free eligible.',
        fix: 'You have probably exceeded 4 OCPUs / 24 GB of Ampere across all your instances. Reduce this instance to 1 OCPU and 6 GB.',
      },
    ],
  },
  {
    id: 'networking',
    title: 'Assign a public IPv4 address',
    summary: 'Make sure the instance gets a public address.',
    why: 'This is the address the whole internet will use to reach you, and the address your domain will point at. Without it there is no gateway — this is the single most commonly missed setting.',
    expect: 'Under Networking, "Assign a public IPv4 address" is selected.',
    illustration: 'oracle-public-ip',
    instructions: [
      'Scroll to the Networking panel.',
      'Leave "Create new virtual cloud network" selected if this is your first instance.',
      'Under "Primary network interface", make sure Assign a public IPv4 address is chosen — not "Do not assign".',
    ],
    troubleshooting: [
      {
        problem: 'I already created the instance without a public IP.',
        fix: 'Open the instance → Attached VNICs → the primary VNIC → IPv4 Addresses → Edit → assign an ephemeral public IP.',
      },
    ],
  },
  {
    id: 'ssh',
    title: 'Create an SSH key',
    summary: 'Download the key LocalTunnel will use to install the gateway.',
    why: 'SSH keys are how you prove to your server that you are its owner. LocalTunnel reads the private key once, to install the gateway for you, and never copies or uploads it.',
    expect: 'A private key file lands in your Downloads folder, usually named something like ssh-key-2026-08-14.key.',
    collects: ['sshKey'],
    instructions: [
      'In the "Add SSH keys" panel, choose Generate a key pair for me.',
      'Press Save private key. Keep this file — you cannot download it again.',
      'Optionally save the public key too.',
      'If you already have an SSH key, choose "Paste public keys" and paste the contents of your ~/.ssh/id_ed25519.pub instead.',
    ],
    troubleshooting: [
      {
        problem: 'I lost the private key.',
        fix: 'Terminate the instance and create a new one with a fresh key. A key cannot be recovered or replaced after creation.',
      },
      {
        problem: 'macOS says the key file is not secure.',
        fix: 'Run `chmod 600` on the downloaded file. LocalTunnel does not require this, but ssh on the command line does.',
      },
    ],
  },
  {
    id: 'create',
    title: 'Create the instance',
    summary: 'Launch the VM and wait for it to start.',
    why: 'This actually builds the server.',
    expect: 'The instance page shows a large orange "PROVISIONING" square that turns green and says RUNNING after a minute or two.',
    instructions: [
      'Press Create at the bottom of the form.',
      'Wait for the state to change from PROVISIONING to RUNNING.',
    ],
    troubleshooting: [
      {
        problem: '"Out of host capacity".',
        fix: 'See the shape step — switch to VM.Standard.E2.1.Micro or retry later.',
      },
      {
        problem: 'The instance says RUNNING but I cannot connect.',
        fix: 'Give it another minute — the OS is still booting after the instance is marked running.',
      },
    ],
  },
  {
    id: 'security-list',
    title: 'Open ports 443 and 80',
    summary: 'Add ingress rules to the VCN security list.',
    why: 'Oracle puts its own firewall in front of every instance, and it blocks everything except SSH by default. Your gateway needs exactly two inbound ports: 443 for HTTPS and the tunnel itself, and 80 so Let\'s Encrypt can issue your certificate. LocalTunnel handles the firewall *inside* the server for you — this rule is the one part Oracle only lets you set yourself.',
    expect: 'The Default Security List shows ingress rules for 0.0.0.0/0 on TCP 443 and TCP 80, alongside the existing rule for port 22.',
    illustration: 'oracle-ingress',
    link: { label: 'Open Virtual Cloud Networks', url: 'https://cloud.oracle.com/networking/vcns' },
    instructions: [
      'Open Networking → Virtual Cloud Networks and click your VCN.',
      'In the left panel, click Security Lists, then Default Security List.',
      'Press Add Ingress Rules.',
      'Rule 1 — Source CIDR: 0.0.0.0/0, IP Protocol: TCP, Destination Port Range: 443.',
      'Press "+ Another Ingress Rule".',
      'Rule 2 — Source CIDR: 0.0.0.0/0, IP Protocol: TCP, Destination Port Range: 80.',
      'Press Add Ingress Rules to save.',
    ],
    troubleshooting: [
      {
        problem: 'I added the rules but the gateway is still unreachable.',
        fix: 'Check you edited the security list attached to the subnet your instance is in. If your VCN was created by the wizard there is only one, but accounts with several VCNs often have the rules on the wrong one.',
      },
      {
        problem: 'My VCN uses Network Security Groups instead.',
        fix: 'Add the same two rules to the NSG attached to the instance\'s VNIC. Either mechanism works; you only need one of them to allow the traffic.',
      },
      {
        problem: 'Do I need to open port 25565 for Minecraft?',
        fix: 'Only if you publish a Minecraft service later. LocalTunnel tells you the exact port to add when that happens, and opens it inside the server automatically.',
      },
    ],
  },
  {
    id: 'ip',
    title: 'Copy the public IP address',
    summary: 'Find the address LocalTunnel needs.',
    why: 'This is what you type into LocalTunnel, and what your domain\'s A record will point to.',
    expect: 'An address like 129.153.x.x under "Public IPv4 address" on the instance page.',
    collects: ['publicIp'],
    link: { label: 'Open Compute → Instances', url: 'https://cloud.oracle.com/compute/instances' },
    instructions: [
      'Open Compute → Instances and click your instance.',
      'Find "Public IPv4 address" in the Instance access / Primary VNIC section.',
      'Copy it.',
      'Note the username shown next to it — "ubuntu" for Ubuntu images, "opc" for Oracle Linux.',
    ],
    troubleshooting: [
      {
        problem: 'There is no public IPv4 address.',
        fix: 'The instance was created without one. Attached VNICs → primary VNIC → IPv4 Addresses → Edit → assign an ephemeral public IP.',
      },
    ],
  },
  {
    id: 'install',
    title: 'Install the LocalTunnel Gateway',
    summary: 'LocalTunnel connects over SSH and sets everything up.',
    why: 'This installs the gateway software, creates its own restricted system user, generates its cryptographic identity, configures the firewall inside the server, and starts it as a system service — the parts that would otherwise be an afternoon of terminal work.',
    expect: 'A checklist runs through fourteen steps and finishes with "Gateway online".',
    collects: ['publicIp', 'username', 'sshKey'],
    instructions: [
      'Enter the public IPv4 address you copied.',
      'Enter the SSH username (ubuntu for Ubuntu, opc for Oracle Linux).',
      'Choose the private key file you downloaded.',
      'Press Install LocalTunnel Gateway and watch it work.',
    ],
    troubleshooting: [
      {
        problem: 'The SSH connection times out.',
        fix: 'The instance may still be booting, or port 22 is not open in the security list. Wait a minute and retry.',
      },
      {
        problem: '"All configured authentication methods failed".',
        fix: 'Almost always the wrong username. Ubuntu images use "ubuntu"; Oracle Linux uses "opc". Also confirm you selected the private key, not the .pub file.',
      },
    ],
  },
  {
    id: 'verify',
    title: 'Test the connection',
    summary: 'Confirm the gateway is reachable from the internet.',
    why: 'This is the moment that proves the Oracle firewall rules are right. It is much easier to fix now than when your site is not loading later.',
    expect: 'Green ticks for gateway reachable, gateway online, and agent connected.',
    instructions: [
      'LocalTunnel connects to your gateway from this computer, exactly as a visitor would.',
      'If a check fails, the fix is shown directly under it.',
      'Then connect this computer, and publish your first service.',
    ],
    troubleshooting: [
      {
        problem: 'Gateway reachable fails but the install succeeded.',
        fix: 'This is the Oracle ingress rule for TCP 443. Go back to the "Open ports 443 and 80" step and check it was added to the right security list.',
      },
    ],
  },
];

export const ORACLE_REQUIRED_PORTS = [
  { port: 443, proto: 'TCP', reason: 'HTTPS for your visitors, and the encrypted tunnel from your computer' },
  { port: 80, proto: 'TCP', reason: "Let's Encrypt certificate issuance, and redirecting http:// to https://" },
];
