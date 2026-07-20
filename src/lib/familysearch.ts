// Stage 1: OAuth connection only. FamilySearch splits its identity server
// (login/token) from its API server, and both have separate hostnames per
// environment. We only use "integration" (the free sandbox, test data
// only) right now — production requires a separate FamilySearch review
// we haven't gone through. See developers.familysearch.org.
const IDENTITY_HOSTS = {
  integration: "https://identint.familysearch.org",
  production: "https://ident.familysearch.org",
} as const;

const API_HOSTS = {
  integration: "https://api-integ.familysearch.org",
  production: "https://api.familysearch.org",
} as const;

function getEnv(): keyof typeof IDENTITY_HOSTS {
  const env = process.env.FAMILYSEARCH_ENV ?? "integration";
  if (env !== "integration" && env !== "production") {
    throw new Error(`Invalid FAMILYSEARCH_ENV: ${env}`);
  }
  return env;
}

function getClientId() {
  const clientId = process.env.FAMILYSEARCH_CLIENT_ID;
  if (!clientId) throw new Error("FAMILYSEARCH_CLIENT_ID is not set");
  return clientId;
}

function getRedirectUri() {
  const redirectUri = process.env.FAMILYSEARCH_REDIRECT_URI;
  if (!redirectUri) throw new Error("FAMILYSEARCH_REDIRECT_URI is not set");
  return redirectUri;
}

export function buildAuthorizationUrl(state: string) {
  const url = new URL(`${IDENTITY_HOSTS[getEnv()]}/cis-web/oauth2/v3/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", getClientId());
  url.searchParams.set("redirect_uri", getRedirectUri());
  // openid gets us identity claims alongside the access token; no
  // offline_access yet (see the familysearch_connection migration note) —
  // FamilySearch requires emailing devsupport to enable refresh tokens on
  // an app key, which Stage 1 deliberately skips.
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(code: string) {
  const res = await fetch(`${IDENTITY_HOSTS[getEnv()]}/cis-web/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
    }),
  });

  if (!res.ok) {
    throw new Error(`FamilySearch token exchange failed: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  }>;
}

export async function fetchCurrentUser(accessToken: string) {
  const res = await fetch(`${API_HOSTS[getEnv()]}/platform/users/current`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`FamilySearch current-user request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    users?: { id: string; displayName: string }[];
  };
  const user = body.users?.[0];
  if (!user) throw new Error("FamilySearch current-user response had no user");
  return user;
}
