// routes/api/hulls.ts
import type { FastifyPluginAsync } from "fastify";
import { queryHulls } from "@strabon/db";
import {
  HULL_KINDS,
  ROLE_ORDER,
  type HullKind,
  type RoleQualifier,
} from "@strabon/shared";

type Query = { year?: string; kind?: string; minRole?: string };

export const apiHullsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Query }>("/hulls", async (req, reply) => {
    const year = parseInt(req.query.year ?? "0", 10);

    // One hull kind at a time. Stacking several was unreadable — the client
    // simply does not call this route when no kind is selected.
    const kind = req.query.kind as HullKind | undefined;
    if (!kind || !HULL_KINDS.includes(kind)) {
      return reply.code(400).send({
        error: `kind must be one of: ${HULL_KINDS.join(", ")}`,
      });
    }

    const minRole = (req.query.minRole ?? "major") as RoleQualifier;
    if (!ROLE_ORDER.includes(minRole)) {
      return reply.code(400).send({
        error: `minRole must be one of: ${ROLE_ORDER.join(", ")}`,
      });
    }

    const features = await queryHulls(kind, year, { minRole });

    return reply.send({ type: "FeatureCollection", features });
  });
};
