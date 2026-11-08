/** Internal auth result: token material is consumed only by the HTTP cookie boundary. */
export type PublicSessionResult = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  user: { userId: string; displayName: string; roleType: number };
  device: { deviceId: string; trusted: boolean };
};

export type SessionResult = PublicSessionResult & {
  sid: string;
  refreshToken: string;
};

/** Strip bearer refresh material before serializing the public response envelope. */
export function toPublicSession(result: SessionResult): PublicSessionResult {
  const { sid: _sid, refreshToken: _refreshToken, ...publicResult } = result;
  return publicResult;
}
