import type { Config } from "@netlify/functions";

// Public upload endpoint disabled — use recent-work-upload (admin session required).
export default async () => {
  return Response.json({ ok: false, error: "endpoint_disabled" }, { status: 403 });
};

export const config: Config = {
  method: "POST",
  path: "/upload",
};
