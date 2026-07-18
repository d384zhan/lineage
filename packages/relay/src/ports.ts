export function choosePort(port: number): number {
  if (port !== 0) return port;
  return 20_000 + Math.floor(Math.random() * 30_000);
}
