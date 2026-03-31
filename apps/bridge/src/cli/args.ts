export type CliCommand =
  | { name: "up"; tailscale: boolean }
  | { name: "stop" }
  | { name: "status" }
  | { name: "serve" }
  | { name: "help" };

export const CLI_HELP = `Usage:
  rmtcdx
  rmtcdx up [--tailscale]
  rmtcdx stop
  rmtcdx status

Commands:
  up           Start rmtcdx in the background.
  stop         Stop the running background process.
  status       Show the current runtime status.

Options:
  --tailscale  Publish the app through Tailscale Serve after startup.

Notes:
  Running \`rmtcdx\` without a subcommand is the same as \`rmtcdx up\`.
`;

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv.length === 0) {
    return { name: "up", tailscale: false };
  }

  const [first, ...rest] = argv;
  const command = first ?? "";

  if (command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  if (command === "serve") {
    if (rest.length > 0) {
      throw new Error("The internal `serve` command does not accept extra arguments.");
    }

    return { name: "serve" };
  }

  if (command === "stop" || command === "status") {
    if (rest.length > 0) {
      throw new Error(`Unknown arguments for \`${command}\`: ${rest.join(" ")}`);
    }

    return { name: command };
  }

  if (command === "up") {
    return {
      name: "up",
      tailscale: parseUpFlags(rest)
    };
  }

  if (command.startsWith("-")) {
    throw new Error(`Unknown option: ${command}`);
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseUpFlags(args: string[]) {
  let tailscale = false;

  for (const arg of args) {
    if (arg === "--tailscale") {
      tailscale = true;
      continue;
    }

    throw new Error(`Unknown option for \`up\`: ${arg}`);
  }

  return tailscale;
}
