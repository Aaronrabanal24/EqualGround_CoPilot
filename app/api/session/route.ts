export async function POST() {
  const backendUrl = process.env.BACKEND_URL;
  const apiKey = process.env.COPILOT_API_KEY;

  if (!backendUrl || !apiKey) {
    return Response.json(
      { error: "Server misconfiguration" },
      { status: 500 },
    );
  }

  const res = await fetch(`${backendUrl}/auth/session`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
  });

  if (!res.ok) {
    return Response.json(
      { error: "Failed to create session" },
      { status: res.status },
    );
  }

  const data = await res.json();
  return Response.json(data);
}
