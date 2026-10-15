/** Best-effort voice + no-op if the PAI notify server isn't running. */
export async function voice(message: string): Promise<void> {
  try {
    await fetch("http://localhost:31337/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* notify server optional */ }
}
