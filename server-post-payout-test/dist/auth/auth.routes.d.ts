import { type Request, type Response, type NextFunction } from "express";
declare const router: import("express-serve-static-core").Router;
export declare function requireAuth(request: Request, response: Response, next: NextFunction): void;
export declare function requireOwner(request: Request, response: Response, next: NextFunction): void;
export default router;
//# sourceMappingURL=auth.routes.d.ts.map