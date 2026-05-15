export const WebContainer = {
  async boot(): Promise<never> {
    throw new Error("WebContainer is unavailable during SSR.");
  },
};

export function configureAPIKey() {}

export const auth = {
  init() {
    return { status: "need-auth" as const };
  },
  async loggedIn() {},
  logout: async () => {},
  on: () => () => {},
  startAuthFlow: () => {},
};
