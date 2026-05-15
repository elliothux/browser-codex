import { spawn } from "node:child_process";
import path from "node:path";

const components = process.argv.slice(2);

if (components.length === 0) {
  console.error("Usage: bun run ui:add <component...>");
  process.exit(1);
}

const uiDir = path.join(process.cwd(), "packages/ui");

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: uiDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`${command} ${args.join(" ")} failed with code ${code}`),
      );
    });
  });
}

async function main() {
  await run("bunx", ["--bun", "shadcn", "add", ...components]);
  await run("bun", ["run", "fix:imports"]);
  await run("bun", ["run", "typecheck"]);
}

void main();
