import path from "node:path";

type CreateCodexProcessEnvOptions = {
  codexHomeDir?: string;
  platform?: NodeJS.Platform;
};

export function createCodexProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: CreateCodexProcessEnvOptions = {}
): NodeJS.ProcessEnv {
  if (!options.codexHomeDir) {
    return { ...baseEnv };
  }

  const platform = options.platform ?? process.platform;
  const pathModule = platform === "win32" ? path.win32 : path;
  const codexHomeDir = pathModule.resolve(options.codexHomeDir);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: codexHomeDir
  };

  if (platform === "win32") {
    env.USERPROFILE = codexHomeDir;
    const parsedRoot = path.win32.parse(codexHomeDir).root;
    if (/^[A-Za-z]:\\$/.test(parsedRoot)) {
      env.HOMEDRIVE = parsedRoot.slice(0, 2);
      env.HOMEPATH = codexHomeDir.slice(2) || "\\";
    }
  }

  return env;
}
