/** Conservative marker shared by CLI resume handling and Build attribution. */
export function containsMcpStartupTransportFatal(message: string): boolean {
  if (!/\bmcp\b/i.test(message)) return false;
  return /failed\s+to\s+(?:start|initialize|connect)|(?:startup|initialization|handshake)\s+failed|(?:transport|connection)\s+(?:error|closed|failed|terminated)|timed\s+out/i.test(message);
}
