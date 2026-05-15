import type { FileSystemTree } from "@webcontainer/api";

export function defaultWorkspaceTree(): FileSystemTree {
  return {
    workspace: {
      directory: {
        "package.json": {
          file: {
            contents: `${JSON.stringify(
              {
                scripts: {
                  test: "node ./test.js",
                },
                dependencies: {},
                devDependencies: {},
              },
              null,
              2,
            )}\n`,
          },
        },
        "session.md": {
          file: {
            contents: "# Browser Codex Session\n\n",
          },
        },
        "test.js": {
          file: {
            contents:
              "const fs = require('fs');\nconsole.log(fs.readFileSync('session.md', 'utf8').trim());\n",
          },
        },
      },
    },
  };
}
