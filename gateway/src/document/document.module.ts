import { Controller, Get, HttpException, HttpStatus, Module, NotFoundException, Param } from "@nestjs/common";
import { CacheService } from "../cache/cache.module.js";

const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";
const NEO4J_HTTP = process.env.NEO4J_HTTP_URL ?? "http://neo4j:7474";
// A document (incl. its citation neighborhood) changes only on re-index, while
// the drawer/detail page can be hit repeatedly. Cache the assembled response.
const DOC_TTL_SEC = Number(process.env.DOCUMENT_CACHE_TTL_SEC ?? 300);
