// Cloudflare Pages dynamic route: /api/db/file/:id
// Uses the same authentication and R2-backed handlers as /api/db.
import { onRequestGet, onRequestPut, onRequestDelete } from "../../db.js";

export { onRequestGet, onRequestPut, onRequestDelete };
