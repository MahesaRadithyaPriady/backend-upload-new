import { google } from 'googleapis';

let driveClient = null;
let oauth2Client = null;

export function getDrive() {
  if (driveClient) return driveClient;
  try {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    const refreshToken = process.env.REFRESH_TOKEN;
    const redirectUri = process.env.REDIRECT_URI || 'http://localhost';

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing required env vars: CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN');
    }

    oauth2Client = new google.auth.OAuth2({ clientId, clientSecret, redirectUri });
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
  } catch (e) {
    console.error('[Drive] Failed to initialize Google Drive client (OAuth2)', {
      error: e?.message,
      stack: e?.stack,
    });
    throw e;
  }
  return driveClient;
}

export function getOAuth2() {
  if (oauth2Client) return oauth2Client;
  // Ensure drive client is initialized (which also sets oauth2Client)
  getDrive();
  return oauth2Client;
}

export async function getAccessToken() {
  const oauth2 = getOAuth2();
  const token = await oauth2.getAccessToken();
  // token can be an object or string depending on googleapis version
  return typeof token === 'string' ? token : token?.token;
}
