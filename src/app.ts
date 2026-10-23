import express from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { authentication } from "./auth.js";
import { Reservations, Problem, type Principal } from "./service.js";
const uuid = (id: string) => {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  )
    throw new Problem(400, "Invalid identifier");
  return id;
};
function exactBody(body: any, keys: string[]) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !keys.includes(k))
  )
    throw new Problem(400, "Unexpected request body");
}
export function app(
  service: Reservations,
  env: NodeJS.ProcessEnv = process.env,
) {
  const auth = authentication(env);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
    next();
  });
  app.get("/health", async (_req, res) => {
    await service.db.query("SELECT 1");
    res.json({ ok: true });
  });
  app.get("/api/config", (_req, res) =>
    res.json({
      demo: auth.demo,
      holdSeconds: service.holdSeconds,
      storage: env.EMBEDDED_DEMO === "true" ? "embedded" : "postgresql",
    }),
  );
  app.use("/api", (req, res, next) => {
    try {
      res.locals.principal = auth.resolve(req.headers);
      res.set("Cache-Control", "no-store");
      next();
    } catch (e) {
      next(e);
    }
  });
  const p = (res: express.Response) => res.locals.principal as Principal;
  const admin = (res: express.Response) => {
    if (p(res).role !== "admin")
      throw new Problem(403, "Administrator permission required");
  };
  const command = async (
    req: express.Request,
    res: express.Response,
    run: Parameters<Reservations["command"]>[3],
  ) => {
    const result = await service.command(
      p(res),
      String(req.headers["idempotency-key"] ?? ""),
      JSON.stringify({
        method: req.method,
        path: req.path,
        body: Object.fromEntries(
          Object.entries(req.body ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
      run,
    );
    res.status(result.status).json(result.body);
  };
  app.get("/api/me", (_req, res) => res.json(p(res)));
  app.get("/api/slots", async (_req, res) =>
    res.json(await service.list(p(res))),
  );
  app.post("/api/slots/:id/holds", async (req, res) => {
    exactBody(req.body ?? {}, []);
    const id = uuid(String(req.params.id));
    await command(req, res, (c) => service.hold(c, p(res), id));
  });
  for (const action of ["confirm", "cancel"] as const)
    app.post(`/api/reservations/:id/${action}`, async (req, res) => {
      exactBody(req.body ?? {}, []);
      const id = uuid(String(req.params.id));
      await command(req, res, (c) => service.transition(c, p(res), id, action));
    });
  app.post("/api/slots", async (req, res) => {
    admin(res);
    exactBody(req.body, [
      "title",
      "location",
      "startsAt",
      "endsAt",
      "capacity",
    ]);
    const b = req.body;
    if (
      typeof b.title !== "string" ||
      !b.title.trim() ||
      b.title.length > 120 ||
      typeof b.location !== "string" ||
      !b.location.trim() ||
      b.location.length > 120 ||
      !Number.isInteger(b.capacity) ||
      b.capacity < 1 ||
      b.capacity > 1000 ||
      typeof b.startsAt !== "string" ||
      typeof b.endsAt !== "string" ||
      !Number.isFinite(Date.parse(b.startsAt)) ||
      !Number.isFinite(Date.parse(b.endsAt)) ||
      Date.parse(b.endsAt) <= Date.parse(b.startsAt)
    )
      throw new Problem(
        400,
        "Provide a title, location, future time range and capacity 1–1000",
      );
    await command(req, res, async (c) => {
      if (Date.parse(b.startsAt) <= Date.now())
        throw new Problem(400, "Session must start in the future");
      const r = (
        await c.query(
          "INSERT INTO slots(id,title,location,starts_at,ends_at,capacity) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            b.title.trim(),
            b.location.trim(),
            new Date(b.startsAt).toISOString(),
            new Date(b.endsAt).toISOString(),
            b.capacity,
          ],
        )
      ).rows[0];
      await service.event(c, "slot.created", { id: r.id });
      return { status: 201, body: r };
    });
  });
  app.post("/api/admin/expire", async (_req, res) => {
    admin(res);
    res.json({ slots: await service.sweep() });
  });
  app.get("/api/admin/outbox", async (_req, res) => {
    admin(res);
    res.json(
      (
        await service.db.query(
          "SELECT id,type,created_at,attempts,lease_until,delivered_at FROM outbox ORDER BY id DESC LIMIT 100",
        )
      ).rows,
    );
  });
  app.post("/api/admin/outbox/claim", async (req, res) => {
    admin(res);
    exactBody(req.body ?? {}, ["limit", "leaseSeconds"]);
    res.json(
      await service.claim(req.body?.limit ?? 10, req.body?.leaseSeconds ?? 30),
    );
  });
  app.post("/api/admin/outbox/:id/ack", async (req, res) => {
    admin(res);
    exactBody(req.body, ["leaseToken"]);
    if (!/^\d{1,18}$/.test(String(req.params.id)))
      throw new Problem(400, "Invalid event id");
    await service.ack(String(req.params.id), uuid(req.body.leaseToken));
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  app.use(express.static(resolve("public")));
  app.get(/.*/, (_req, res) => res.sendFile(resolve("public/index.html")));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err instanceof Problem
          ? err.status
          : err.type === "entity.too.large"
            ? 413
            : err.type === "entity.parse.failed"
              ? 400
              : 500;
      if (status === 500) console.error("request failed", err.code ?? err.name);
      res.status(status).json({
        error:
          status === 500
            ? "Internal server error"
            : status === 413
              ? "Request is too large"
              : status === 400 && !(err instanceof Problem)
                ? "Invalid JSON"
                : err.message,
      });
    },
  );
  return app;
}
