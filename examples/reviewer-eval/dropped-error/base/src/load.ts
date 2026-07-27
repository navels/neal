export async function loadConfig(read: () => Promise<string>): Promise<string> {
  const raw = await read();
  return raw.trim();
}
